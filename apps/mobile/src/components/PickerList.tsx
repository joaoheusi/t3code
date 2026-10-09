import type { ReactNode } from "react";
import {
  Platform,
  Pressable,
  TextInput,
  View,
  type AccessibilityRole,
  type PressableProps,
} from "react-native";

import { cn } from "../lib/cn";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { MaterialListRow } from "./MaterialListRow";
import { ThemedSwitch } from "./ThemedSwitch";

/** A grouped card holding picker rows, matching the new-task pickers. */
export function PickerSurface(props: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <View
      className={cn(
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-2xl bg-grouped-card",
        props.className,
      )}
    >
      {props.children}
    </View>
  );
}

/** Small caption above or below a picker card. */
export function PickerCaption(props: { readonly children: ReactNode; readonly tone?: "danger" }) {
  return (
    <Text
      className={cn(
        "px-4 text-xs leading-normal",
        props.tone === "danger" ? "text-danger" : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}

/** One row in a picker card. `selected` shows a checkmark; `trailing` replaces it. */
export function PickerRow(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly symbol?: AppSymbolName;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean;
  readonly tone?: "accent" | "danger" | "muted";
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  /** Forwarded so a long-press ControlPillMenu can wrap the row. */
  readonly onTouchStart?: PressableProps["onTouchStart"];
  readonly disabled?: boolean;
  readonly isLast?: boolean;
  readonly accessibilityRole?: AccessibilityRole;
  readonly accessibilityHint?: string;
}) {
  const titleClassName =
    props.tone === "danger"
      ? "text-danger"
      : props.tone === "accent"
        ? "text-primary-text"
        : props.tone === "muted"
          ? "text-foreground-muted"
          : "text-foreground";
  const leading =
    props.leading ??
    (props.symbol ? (
      <SymbolView
        name={props.symbol}
        size={Platform.OS === "android" ? 24 : 17}
        tintColorClassName={
          props.tone === "danger" ? "accent-danger-foreground" : "accent-icon-muted"
        }
        type="monochrome"
      />
    ) : null);
  const trailing =
    props.trailing ??
    (props.selected ? (
      <SymbolView
        name="checkmark"
        size={Platform.OS === "android" ? 20 : 16}
        tintColorClassName={Platform.OS === "android" ? "accent-focus" : "accent-icon"}
        type="monochrome"
        weight="semibold"
      />
    ) : null);
  const role = props.accessibilityRole ?? (props.selected === undefined ? "button" : "radio");
  const state =
    props.selected === undefined
      ? { disabled: props.disabled }
      : { checked: props.selected, disabled: props.disabled };
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        titleClassName={titleClassName}
        subtitle={props.subtitle}
        leading={leading}
        trailing={trailing}
        accessibilityRole={role}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={state}
        disabled={props.disabled}
        onPress={props.onPress}
        onLongPress={props.onLongPress}
        onTouchStart={props.onTouchStart}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole={role}
      accessibilityState={state}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3",
        props.onPress && "active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onTouchStart={props.onTouchStart}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {leading}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className={cn("text-base font-t3-medium", titleClassName)} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

export function PickerToggleRow(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3",
        Platform.OS !== "android" && !props.isLast && "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn("text-base text-foreground", Platform.OS !== "android" && "font-t3-medium")}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={props.title}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

/** The rounded search field the branch picker uses on Android, for screens without a native one. */
export function PickerSearchField(props: {
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel={props.placeholder}
      className="h-11 rounded-full border border-input-border bg-input px-4 font-sans text-base text-foreground"
      selectionColorClassName="accent-focus/32"
      cursorColorClassName="accent-focus"
      selectionHandleColorClassName="accent-focus"
      clearButtonMode="while-editing"
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColorClassName="accent-placeholder"
      value={props.value}
    />
  );
}
