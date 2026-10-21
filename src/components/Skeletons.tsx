export function FormSkeleton() {
  return <div className="h-[118px] animate-pulse rounded-2xl border border-border bg-surface" />;
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[76px] animate-pulse rounded-xl border border-border bg-surface" />
      ))}
    </div>
  );
}
