import { PRODUCT } from '@/lib/product';

/** Original 视频创作 mark: a play triangle in a frame, above a three-clip timeline. */
export function BrandLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className="block shrink-0" role="img" aria-label={PRODUCT.displayName}>
      <rect x="7" y="8" width="50" height="36" rx="9" stroke="currentColor" strokeWidth="5" />
      <path d="M27 18 42 26 27 35Z" fill="currentColor" />
      <path d="M9 54h12m6 0h17m6 0h5" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
