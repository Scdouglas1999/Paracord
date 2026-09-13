interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

// A placeholder is a matte wash, gently pulsed — never a sweeping sheen
// (§6.2: no gradient wash across a surface). The pulse is opacity-only, so it
// stays calm under prefers-reduced-motion.
export function Skeleton({ width, height, borderRadius = 'var(--radius-chip)', className = '' }: SkeletonProps) {
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
      <Skeleton width={40} height={40} borderRadius="var(--radius-full)" className="shrink-0" />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Skeleton width="30%" height={14} borderRadius="var(--radius-chip)" />
          <Skeleton width={48} height={10} borderRadius="var(--radius-chip)" />
        </div>
        <Skeleton width="90%" height={14} borderRadius="var(--radius-chip)" />
        <div className="mt-1">
          <Skeleton width="60%" height={14} borderRadius="var(--radius-chip)" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonChannel() {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5">
      <Skeleton width={16} height={16} borderRadius="var(--radius-chip)" className="shrink-0" />
      <Skeleton width="70%" height={14} borderRadius="var(--radius-chip)" />
    </div>
  );
}

export function SkeletonMember() {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5">
      <Skeleton width={32} height={32} borderRadius="var(--radius-full)" className="shrink-0" />
      <Skeleton width="60%" height={14} borderRadius="var(--radius-chip)" />
    </div>
  );
}
