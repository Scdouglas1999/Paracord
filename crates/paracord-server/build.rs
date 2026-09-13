// The embedded web UI (`embedded_ui.rs`, rust-embed over `client/dist`) is read
// at compile time by a proc macro, and cargo cannot see that dependency on its
// own: rebuilding after only the client changed kept the previous bundle inside
// the binary and served it as if it were current. Declare the directory so any
// change to the built client invalidates this crate.
fn main() {
    println!("cargo:rerun-if-changed=../../client/dist");
}
