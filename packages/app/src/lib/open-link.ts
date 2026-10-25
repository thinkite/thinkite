import * as WebBrowser from "expo-web-browser";
import { useCallback } from "react";
import { Alert, Linking } from "react-native";
import { useDaemonClient } from "./daemon-client-context";
import { localPort, macPageNotice } from "./mac-link";

/**
 * What a link in a message does when tapped. The agent shows the user a
 * page by linking it in a reply: a page on the Mac is told apart by its
 * port; any other opens in an in-app browser.
 */
export function useOpenLink(): (url: string) => void {
  const { client, connectionStatus } = useDaemonClient();
  return useCallback(
    (url: string) => {
      const port = localPort(url);
      if (port === undefined) {
        if (/^https?:/i.test(url)) void WebBrowser.openBrowserAsync(url);
        else void Linking.openURL(url).catch(() => undefined);
        return;
      }
      const ports =
        connectionStatus === "online"
          ? client.getForwardPorts()
          : Promise.resolve([]);
      void ports
        .catch(() => [])
        .then((list) => {
          const { title, message } = macPageNotice(port, list);
          Alert.alert(title, message);
        });
    },
    [client, connectionStatus],
  );
}
