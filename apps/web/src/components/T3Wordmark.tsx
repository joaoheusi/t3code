import type { SVGProps } from "react";

/** The J4 fork's mark. It keeps upstream's name so fork merges stay small. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="18.6 37 91.3 56.96" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M30.5 37H59V72.2C59 84.9 50.3 93.96 37.6 93.96C29.7 93.96 22.9 90.6 18.6 84.6L26.2 75.6C29 79.6 32.5 81.8 36.9 81.8C42.6 81.8 46 78.1 46 71.6V47.56H30.5Z M84.6 37H100.1V70.6H109.9V81.4H100.1V93H87.3V81.4H65.4V71.6Z M80.2 70.6H87.3V58.4Z"
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}
