import { useState, useRef, useMemo, useEffect } from 'react';
import { Upload, X, FileText, AlertTriangle } from 'lucide-react';
import { isAllowedImageMimeType } from '../../lib/security';

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  stagedFiles: File[];
  onRemoveFile: (index: number) => void;
}

const ONE_GB = 1024 * 1024 * 1024;

function canPreviewImage(file: File): boolean {
  return isAllowedImageMimeType(file.type);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < ONE_GB) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / ONE_GB).toFixed(1) + ' GB';
}

export function FileUpload({ onFilesSelected, stagedFiles, onRemoveFile }: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stagedImagePreviews = useMemo(
    () =>
      stagedFiles.map((file) => (
        canPreviewImage(file) ? URL.createObjectURL(file) : null
      )),
    [stagedFiles]
  );

  useEffect(() => {
    return () => {
      stagedImagePreviews.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    };
  }, [stagedImagePreviews]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFilesSelected(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) onFilesSelected(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div>
      {/* Drop zone */}
      <button
        type="button"
        className="cursor-pointer rounded-xl border-2 border-dashed p-7 text-center transition-colors"
        style={{
          borderColor: isDragOver ? 'var(--accent-primary)' : 'var(--border-subtle)',
          backgroundColor: isDragOver ? 'var(--bg-mod-subtle)' : 'transparent',
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        aria-label="Select files to upload"
      >
        <Upload size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 8px' }} />
        <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Drag and drop files here
        </div>
        <div className="mt-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
          or click to browse
        </div>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Staged files */}
      {stagedFiles.length > 0 && (
        <div className="mt-4 space-y-2.5">
          {stagedFiles.map((file, i) => (
            <div
              key={i}
              className="group flex items-center gap-3.5 rounded-lg px-3.5 py-2.5"
              style={{ backgroundColor: 'var(--bg-secondary)' }}
            >
              {canPreviewImage(file) ? (
                <img
                  src={stagedImagePreviews[i] || ''}
                  alt={file.name}
                  className="h-11 w-11 rounded-md object-cover"
                />
              ) : (
                <FileText size={20} style={{ color: 'var(--text-muted)' }} />
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{file.name}</div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatFileSize(file.size)}</div>
              </div>
              {file.size > ONE_GB && (
                <div className="flex items-center gap-1 text-sm" style={{ color: 'var(--accent-warning)' }}>
                  <AlertTriangle size={14} />
                  P2P transfer
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemoveFile(i)}
                className="rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: 'var(--text-muted)' }}
                aria-label={`Remove ${file.name}`}
                title={`Remove ${file.name}`}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
