interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

export function Skeleton({ width, height, borderRadius = '0.5rem', className = '' }: SkeletonProps) {
  return (
    <div
      className={className}
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: 'var(--bg-mod-strong)',
        animation: 'skeleton-pulse 1.8s ease-in-out infinite',
      }}
    />
  );
}

export function SkeletonMessage() {
  return (
    <div className="flex gap-3 px-3 py-2" style={{ marginTop: '1rem' }}>
      <Skeleton width={40} height={40} borderRadius="50%" className="shrink-0" />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Skeleton width="30%" height={14} borderRadius="0.25rem" />
          <Skeleton width={48} height={10} borderRadius="0.25rem" />
        </div>
        <Skeleton width="90%" height={14} borderRadius="0.25rem" />
        <div className="mt-1">
          <Skeleton width="60%" height={14} borderRadius="0.25rem" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonChannel() {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-3 py-2.5">
      <Skeleton width={16} height={16} borderRadius="0.25rem" className="shrink-0" />
      <Skeleton width="70%" height={14} borderRadius="0.25rem" />
    </div>
  );
}

export function SkeletonMember() {
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
      <Skeleton width={32} height={32} borderRadius="50%" className="shrink-0" />
      <Skeleton width="60%" height={14} borderRadius="0.25rem" />
    </div>
  );
}
