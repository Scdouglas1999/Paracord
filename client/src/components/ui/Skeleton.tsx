interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

// Depth over flat gray (design-spec §7 / kill-list #7): a diagonal sheen across
// the elevation-ramp wash, gently pulsed. Pulse is opacity-only, so it stays calm
// under prefers-reduced-motion.
export function Skeleton({ width, height, borderRadius = 'var(--radius-sm)', className = '' }: SkeletonProps) {
  return (
    <div
      className={className}
      style={{
        width,
        height,
        borderRadius,
        backgroundImage:
          'linear-gradient(100deg, var(--bg-mod-subtle) 0%, var(--bg-mod-strong) 50%, var(--bg-mod-subtle) 100%)',
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
          <Skeleton width="30%" height={14} borderRadius="var(--radius-xs)" />
          <Skeleton width={48} height={10} borderRadius="var(--radius-xs)" />
        </div>
        <Skeleton width="90%" height={14} borderRadius="var(--radius-xs)" />
        <div className="mt-1">
          <Skeleton width="60%" height={14} borderRadius="var(--radius-xs)" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonChannel() {
  return (
    <div className="flex items-center gap-2.5 rounded-sm px-3 py-2.5">
      <Skeleton width={16} height={16} borderRadius="var(--radius-xs)" className="shrink-0" />
      <Skeleton width="70%" height={14} borderRadius="var(--radius-xs)" />
    </div>
  );
}

export function SkeletonMember() {
  return (
    <div className="flex items-center gap-3 rounded-sm px-3 py-2.5">
      <Skeleton width={32} height={32} borderRadius="var(--radius-full)" className="shrink-0" />
      <Skeleton width="60%" height={14} borderRadius="var(--radius-xs)" />
    </div>
  );
}
