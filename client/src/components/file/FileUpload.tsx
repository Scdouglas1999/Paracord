import { useState, useRef, useMemo, useEffect } from 'react';
import { UploadCloud, X, FileText, AlertTriangle } from 'lucide-react';
import { isAllowedImageMimeType } from '../../lib/security';
import { formatFileSize } from '../../lib/formatters';

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  stagedFiles: File[];
  onRemoveFile: (index: number) => void;
}

const ONE_GB = 1024 * 1024 * 1024;

function canPreviewImage(file: File): boolean {
  return isAllowedImageMimeType(file.type);
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
      {/* Drop zone (design-spec §7 Input): dashed --border-strong, drag-over lifts to
          an --accent-tint fill with an --accent-primary border. */}
      <button
        type="button"
        className="w-full cursor-pointer rounded-md border border-dashed px-6 py-7 text-center outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]"
        style={{
          borderColor: isDragOver ? 'var(--accent-primary)' : 'var(--border-strong)',
          backgroundColor: isDragOver ? 'var(--accent-tint)' : 'transparent',
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        aria-label="Select files to upload"
      >
        <UploadCloud
          size={26}
          className="mx-auto mb-2.5"
          style={{ color: isDragOver ? 'var(--accent-primary)' : 'var(--text-muted)' }}
        />
        <div className="text-label text-text-primary">Drop files to attach</div>
        <div className="mt-1 text-meta text-text-muted">or click to browse your device</div>
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
        <div className="mt-4 space-y-1.5">
          {stagedFiles.map((file, i) => {
            const oversize = file.size > ONE_GB;
            return (
              <div
                key={i}
                className="group flex items-center gap-3 rounded-sm bg-bg-mod-subtle px-3 py-2 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
              >
                {canPreviewImage(file) ? (
                  <img
                    src={stagedImagePreviews[i] || ''}
                    alt={file.name}
                    className="h-10 w-10 shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-bg-tertiary text-text-muted">
                    <FileText size={18} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-label text-text-primary">{file.name}</div>
                  <div className="text-meta tabular-nums text-text-muted">{formatFileSize(file.size)}</div>
                </div>
                {oversize && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-warning-tint px-2 py-0.5 text-meta font-semibold text-accent-warning">
                    <AlertTriangle size={12} />
                    P2P transfer
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveFile(i)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-[color,background-color,opacity] duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
