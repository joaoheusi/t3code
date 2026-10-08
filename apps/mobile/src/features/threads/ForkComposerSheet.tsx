import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";

export function ForkComposerSheet(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between p-4">
          <Text className="text-lg text-foreground font-t3-bold">{props.title}</Text>
          <Pressable accessibilityRole="button" onPress={props.onClose} className="p-3">
            <Text className="text-foreground">Done</Text>
          </Pressable>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 12 }}
        >
          {props.children}
        </ScrollView>
      </View>
    </Modal>
  );
}
export function ForkSheetButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-xl bg-subtle p-3"
      style={{ opacity: props.disabled ? 0.5 : 1 }}
    >
      <Text className="text-foreground">{props.label}</Text>
    </Pressable>
  );
}
