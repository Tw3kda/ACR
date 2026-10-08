import { createElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

/**
 * Renders the document's print HTML in the same engine expo-print rasterizes
 * with (WKWebView on iOS, Android System WebView), so the preview matches the
 * generated PDF rather than approximating it with a second set of components.
 */
export function DocumentHtmlView({ html }: { html: string }) {
  if (Platform.OS === 'web') {
    // react-native-webview has no web implementation; an iframe is the
    // equivalent primitive and react-native-web passes it straight through.
    return createElement('iframe', {
      srcDoc: html,
      style: { flex: 1, border: 'none', width: '100%', backgroundColor: '#fff' },
    });
  }

  return (
    <View style={styles.container}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        scalesPageToFit
        showsVerticalScrollIndicator
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#fff' },
});
