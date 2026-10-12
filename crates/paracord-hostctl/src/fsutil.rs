//! File operations with the guarantees the spec asks for: directories 0700,
//! private files 0600, and replacements that are never seen half written
//! (temp file in the same directory, fsync, rename).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Create `dir` and its missing parents. On Unix every directory this call
/// creates is 0700; existing ones are left alone. On Windows they inherit the
/// user profile's ACL (spec §2.2).
pub fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_private_dir_all(parent)?;
    }
    match fs::create_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => return Ok(()),
        Err(e) => return Err(e),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// A temp path beside `dest`, unique per call.
fn temp_beside(dest: &Path) -> io::Result<PathBuf> {
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = dest
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    Ok(parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    )))
}

fn open_new(path: &Path, mode: u32) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)
}

fn sync_dir(dir: &Path) {
    // Durability of the rename itself; not available (or needed) on Windows.
    #[cfg(unix)]
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Write `bytes` to `dest` atomically with mode `mode` (Unix).
pub fn write_atomic(dest: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let temp = temp_beside(dest)?;
    let result = (|| {
        let mut file = open_new(&temp, mode)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    } else if let Some(parent) = dest.parent() {
        sync_dir(parent);
    }
    result
}

/// [`write_atomic`] with 0600.
pub fn write_private_atomic(dest: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(dest, bytes, 0o600)
}

/// Copy the executable `source` to `dest` via a temp file beside `dest` and a
/// rename, mode 0755 (spec §2.6 `install`). `dest` is replaced as a whole or
/// not at all.
pub fn install_binary(source: &Path, dest: &Path) -> io::Result<()> {
    let mut input = File::open(source).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "the app's bundled server is missing or unreadable ({}: {e})",
                source.display()
            ),
        )
    })?;
    if let Some(parent) = dest.parent() {
        create_private_dir_all(parent)?;
    }
    let temp = temp_beside(dest)?;
    let result = (|| {
        let mut output = open_new(&temp, 0o755)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o755))?;
        }
        fs::rename(&temp, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    } else if let Some(parent) = dest.parent() {
        sync_dir(parent);
    }
    result
}

/// Move `from` to `to`, replacing `to`.
pub fn replace_with(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    if let Some(parent) = to.parent() {
        sync_dir(parent);
    }
    Ok(())
}

/// Bytes available to this user on the filesystem holding `path` (or its
/// nearest existing ancestor, since the host root may not exist yet).
pub fn free_space(path: &Path) -> io::Result<u64> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => probe = parent.to_path_buf(),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no existing directory above {}", path.display()),
                ))
            }
        }
    }
    free_space_at(&probe)
}

#[cfg(unix)]
fn free_space_at(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c_path is a valid NUL-terminated string and stat is a valid,
    // writable statvfs for the duration of the call.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    #[allow(clippy::unnecessary_cast)]
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(windows)]
fn free_space_at(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: wide is NUL-terminated; the out pointers are valid or null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(not(any(unix, windows)))]
fn free_space_at(_: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "free space is not available on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_binary_replaces_atomically_and_is_executable() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("bundle-paracord-host");
        fs::write(&source, b"new build").unwrap();
        let dest = dir.path().join("host/bin/paracord-host");
        install_binary(&source, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new build");
        fs::write(&source, b"newer build").unwrap();
        install_binary(&source, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"newer build");
        // Nothing left behind but the binary.
        let names: Vec<_> = fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
            let bin_mode = fs::metadata(dest.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(bin_mode, 0o700);
        }
    }

    #[test]
    fn a_missing_bundled_binary_says_so_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("bin/paracord-host");
        let err = install_binary(&dir.path().join("absent"), &dest).unwrap_err();
        assert!(
            err.to_string().contains("bundled server is missing"),
            "{err}"
        );
        assert!(!dest.exists());
    }

    #[test]
    fn private_writes_are_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        write_private_atomic(&path, b"{}").unwrap();
        write_private_atomic(&path, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"a\":1}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn free_space_walks_up_to_an_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let free = free_space(&dir.path().join("not/yet/created")).unwrap();
        assert!(free > 0);
    }
}
