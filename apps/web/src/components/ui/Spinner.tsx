import { LoaderCircle } from "lucide-react";
import type { CSSProperties } from "react";

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className={`animate-spin text-accent ${className}`}
    />
  );
}

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div aria-hidden="true" className={`skeleton ${className}`} style={style} />;
}
