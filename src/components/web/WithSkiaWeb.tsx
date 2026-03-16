import { WithSkiaWeb } from "@shopify/react-native-skia/lib/module/web";
import React from "react";
import { View, Text } from "react-native";

export default function SkiaWebWrapper({ children }: { children: React.ReactNode }) {
  return (
    <WithSkiaWeb
      getComponent={() => Promise.resolve({ default: () => <>{children}</> })}
      fallback={<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><Text>Loading Skia...</Text></View>}
    />
  );
}
