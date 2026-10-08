import type { ColorValue } from "react-native";
import { J4_WORDMARK } from "@t3tools/shared/appBranding";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The J4 brand mark shared with the desktop sidebar.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="J4"
      height={props.height}
      width={props.height * J4_WORDMARK.aspectRatio}
      viewBox={J4_WORDMARK.viewBox}
    >
      <ThemedPath
        d={J4_WORDMARK.path}
        fillRule="evenodd"
        clipRule="evenodd"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
