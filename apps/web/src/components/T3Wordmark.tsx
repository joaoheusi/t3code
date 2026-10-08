import type { SVGProps } from "react";
import { J4_WORDMARK } from "@t3tools/shared/appBranding";

/** The J4 fork's mark. It keeps upstream's name so fork merges stay small. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox={J4_WORDMARK.viewBox} xmlns="http://www.w3.org/2000/svg">
      <path d={J4_WORDMARK.path} fillRule="evenodd" clipRule="evenodd" fill="currentColor" />
    </svg>
  );
}
