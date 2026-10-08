import { useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import type { AppSymbolName } from "../../components/AppSymbol";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";

type HeaderButton = {
  readonly accessibilityLabel: string;
  /** iOS shows the label; Android shows the icon. */
  readonly label?: string;
  readonly icon: AppSymbolName & string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
};

/**
 * The native header for the repositories and quick action screens, both when pushed inside
 * the new-task sheet and when presented as a sheet over a thread.
 */
export function ForkScreenHeader(props: {
  readonly title: string;
  /** Replaces the back button, for example "Cancel" while editing. */
  readonly cancel?: { readonly label: string; readonly onPress: () => void };
  readonly action?: HeaderButton;
}) {
  const navigation = useNavigation();
  if (Platform.OS === "android") {
    return (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader
          title={props.title}
          hideBottomBorder
          onBack={props.cancel?.onPress ?? (() => navigation.goBack())}
          actions={
            props.action
              ? [
                  {
                    accessibilityLabel: props.action.accessibilityLabel,
                    icon: props.action.icon,
                    onPress: props.action.onPress,
                    disabled: props.action.disabled,
                  },
                ]
              : []
          }
        />
      </>
    );
  }
  return (
    <>
      <NativeStackScreenOptions
        options={{ headerShown: true, title: props.title, headerBackVisible: !props.cancel }}
      />
      {props.cancel ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button label={props.cancel.label} onPress={props.cancel.onPress} />
        </NativeHeaderToolbar>
      ) : null}
      {props.action ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            accessibilityLabel={props.action.accessibilityLabel}
            disabled={props.action.disabled}
            {...(props.action.label ? { label: props.action.label } : { icon: props.action.icon })}
            onPress={props.action.onPress}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}
