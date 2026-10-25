import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import { Alert, Linking } from "react-native";
import { localPort, macPageNotice, phonePage } from "./mac-link";
import { forwardState } from "./port-forward";

/**
 * What a link in a message does when tapped. The agent shows the user a
 * page by linking it in a reply. A page on the Mac (by its port) opens
 * through the forwarder on the phone's own localhost (lib/port-forward),
 * in the in-app browser like any other page.
 */
export function openLink(url: string): void {
  const port = localPort(url);
  if (port === undefined) {
    if (/^https?:/i.test(url)) void WebBrowser.openBrowserAsync(url);
    else void Linking.openURL(url).catch(() => undefined);
    return;
  }
  const { ports, listening, failed } = forwardState();
  // The simulator shares the Mac's network: its localhost is the Mac's,
  // forwarder or not.
  const served =
    listening.has(port) ||
    (!Device.isDevice && ports.some((p) => p.port === port));
  if (served) {
    void WebBrowser.openBrowserAsync(phonePage(url));
    return;
  }
  const { title, message } = macPageNotice(port, ports, failed.get(port));
  Alert.alert(title, message);
}
