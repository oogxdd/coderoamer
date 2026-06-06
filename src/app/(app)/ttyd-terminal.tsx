import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import * as api from '@/services/api';

const DEFAULT_HOST = '';
const DEFAULT_USER = 'user';
const DEFAULT_PASS = '';
// Static-binary fallback version when no package manager has ttyd.
const TTYD_VERSION = '1.7.7';
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const MAX_LOG_LINES = 250;

type WebViewHttpErrorEvent = {
  nativeEvent: {
    description?: string;
    statusCode: number;
    url?: string;
  };
};

type WebViewErrorEvent = {
  nativeEvent: {
    code?: number;
    description?: string;
    domain?: string;
    url?: string;
  };
};

type WebViewMessageEvent = {
  nativeEvent: {
    data: string;
  };
};

type WebViewProgressEvent = {
  nativeEvent: {
    progress: number;
    url?: string;
  };
};

type WebViewNavigationEvent = {
  nativeEvent: {
    url?: string;
  };
};

type WebViewNavState = {
  url?: string;
  loading?: boolean;
  title?: string;
};

type TtydLog = {
  message: string;
  timestamp: number;
};

let WebViewComponent: React.ComponentType<any> | null = null;
try {
  WebViewComponent = require('react-native-webview').WebView as React.ComponentType<any>;
} catch {
  WebViewComponent = null;
}

function encodeBase64(value: string): string {
  const utf8 = encodeURIComponent(value).replace(
    /%([0-9A-F]{2})/g,
    (_, hex: string) => String.fromCharCode(parseInt(hex, 16))
  );

  let output = '';
  let index = 0;

  while (index < utf8.length) {
    const chr1 = utf8.charCodeAt(index++);
    const chr2 = utf8.charCodeAt(index++);
    const chr3 = utf8.charCodeAt(index++);

    const enc1 = chr1 >> 2;
    const enc2 = ((chr1 & 3) << 4) | (Number.isNaN(chr2) ? 0 : chr2 >> 4);
    let enc3 = ((chr2 & 15) << 2) | (Number.isNaN(chr3) ? 0 : chr3 >> 6);
    let enc4 = chr3 & 63;

    if (Number.isNaN(chr2)) {
      enc3 = 64;
      enc4 = 64;
    } else if (Number.isNaN(chr3)) {
      enc4 = 64;
    }

    output +=
      BASE64_CHARS.charAt(enc1) +
      BASE64_CHARS.charAt(enc2) +
      BASE64_CHARS.charAt(enc3) +
      BASE64_CHARS.charAt(enc4);
  }

  return output;
}

function buildAuthenticatedUrl(rawUrl: string, username: string, password: string): string {
  if (!rawUrl) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    parsed.username = username;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export default function TtydTerminalScreen() {
  const params = useLocalSearchParams<{ name?: string; cwd?: string }>();
  const spriteName = typeof params.name === 'string' ? params.name : '';
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : '/home/sprite';
  const webViewRef = useRef<any>(null);
  const progressBucketRef = useRef(-1);
  const serviceAbortRef = useRef<AbortController | null>(null);
  const [host, setHost] = useState(DEFAULT_HOST);
  const [username, setUsername] = useState(DEFAULT_USER);
  const [password, setPassword] = useState(DEFAULT_PASS);

  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TtydLog[]>([]);
  const [showLogs, setShowLogs] = useState(true);

  const displayUrl = host.trim().replace(/\/+$/, '');
  const authedUrl = useMemo(
    () => buildAuthenticatedUrl(displayUrl, username, password).replace(/\/+$/, ''),
    [displayUrl, username, password]
  );

  const appendLog = useCallback((message: string) => {
    const timestamp = Date.now();
    setLogs((previous) => {
      const next = previous.length >= MAX_LOG_LINES ? previous.slice(previous.length - MAX_LOG_LINES + 1) : previous;
      return [...next, { message, timestamp }];
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const copyLogs = useCallback(async () => {
    if (!logs.length) return;
    const output = logs
      .map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.message}`)
      .join('\n');
    await Clipboard.setStringAsync(output);
    appendLog('logs: copied to clipboard');
  }, [appendLog, logs]);

  // Prefill the host from the sprite's public URL when launched for a sprite.
  useEffect(() => {
    if (!spriteName) return;
    let mounted = true;
    (async () => {
      try {
        const sprite = await api.getSprite(spriteName);
        if (!mounted) return;
        if (sprite.url) {
          setHost(sprite.url);
          appendLog(`prefilled host from sprite: ${sprite.url}`);
        } else {
          appendLog('sprite has no public URL yet');
        }
      } catch (err: any) {
        if (mounted) appendLog(`could not load sprite: ${err?.message ?? 'error'}`);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [spriteName, appendLog]);

  // Stop streaming the ttyd service logs when leaving the screen.
  useEffect(() => {
    return () => {
      serviceAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isConnected || !loading) return;

    const timeout = setTimeout(() => {
      setLoading(false);
      appendLog('loading timeout hit after 15s; spinner hidden to let you inspect the page');
    }, 15000);

    return () => clearTimeout(timeout);
  }, [appendLog, isConnected, loading]);

  const authHeaders = useMemo(() => {
    const credentials = `${username}:${password}`;
    const encoded =
      typeof globalThis.btoa === 'function' ? globalThis.btoa(credentials) : encodeBase64(credentials);
    return { Authorization: `Basic ${encoded}` };
  }, [username, password]);

  const injectedJS = `
    (function() {
      var post = function(type, payload) {
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
            source: 'ttyd',
            type: type,
            payload: payload || {}
          }));
        } catch (_error) {}
      };

      post('injected', { href: window.location.href, readyState: document.readyState });

      var OriginalWebSocket = window.WebSocket;
      if (OriginalWebSocket && !window.__ttydWsPatched) {
        try {
          window.__ttydWsPatched = true;
          window.WebSocket = function(url, protocols) {
            var ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            post('ws-create', { url: String(url) });
            ws.addEventListener('open', function() {
              post('ws-open', { url: ws.url });
            });
            ws.addEventListener('close', function(event) {
              post('ws-close', { code: event.code, reason: event.reason, wasClean: event.wasClean });
            });
            ws.addEventListener('error', function() {
              post('ws-error', { url: ws.url });
            });
            return ws;
          };
          window.WebSocket.prototype = OriginalWebSocket.prototype;
          try {
            window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
            window.WebSocket.OPEN = OriginalWebSocket.OPEN;
            window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
            window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
          } catch (_error) {}
        } catch (error) {
          post('ws-patch-error', { error: String(error) });
        }
      }

      window.addEventListener('error', function(event) {
        post('window-error', {
          message: event.message,
          source: event.filename,
          line: event.lineno,
          column: event.colno
        });
      });

      window.addEventListener('unhandledrejection', function(event) {
        post('promise-rejection', { reason: String(event.reason) });
      });

      var meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
      document.head.appendChild(meta);

      var style = document.createElement('style');
      style.textContent = 'body, html { margin:0; padding:0; overflow:hidden; background:#1a1b26; }';
      document.head.appendChild(style);

      true;
    })();
  `;

  const handleConnect = () => {
    if (!displayUrl) {
      setError('Please enter the ttyd host URL');
      appendLog('connect: missing host URL');
      return;
    }

    progressBucketRef.current = -1;
    setError(null);
    setLoading(true);
    setIsConnected(true);
    appendLog(`connect: starting ${displayUrl}`);
  };

  // One-tap: open the sprite URL, start ttyd on :8080 in the working dir, then connect.
  const handleBootstrap = async () => {
    if (!spriteName) {
      setError('Open this from a sprite to auto-start ttyd.');
      return;
    }
    setBootstrapping(true);
    setError(null);

    const user = username.trim() || 'user';
    const pass = password.trim() || Math.random().toString(36).slice(2, 10);
    setUsername(user);
    setPassword(pass);

    try {
      appendLog('bootstrap: fetching sprite URL');
      const sprite = await api.getSprite(spriteName);
      if (!sprite.url) throw new Error('sprite has no public URL');
      setHost(sprite.url);

      appendLog('bootstrap: setting URL auth=public');
      await api.updateSpriteUrlAuth(spriteName, 'public');

      appendLog(`bootstrap: starting ttyd on :8080 in ${cwd}`);
      const safePass = pass.replace(/'/g, '');
      const safeUser = user.replace(/'/g, '');
      // Ensure ttyd exists (package manager, else a static binary), then run it in the repo.
      // No `set -e`: each step falls through to the final check. `sudo -n` never prompts.
      const inner = [
        `mkdir -p "${cwd}" 2>/dev/null; cd "${cwd}" 2>/dev/null || true`,
        `if ! command -v ttyd >/dev/null 2>&1; then`,
        `  echo "ttyd not found — trying package manager...";`,
        `  export DEBIAN_FRONTEND=noninteractive;`,
        `  if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi;`,
        `  ( $SUDO apt-get update -y && $SUDO apt-get install -y ttyd ) >/dev/null 2>&1 || $SUDO apk add --no-cache ttyd >/dev/null 2>&1 || $SUDO dnf install -y ttyd >/dev/null 2>&1 || true;`,
        `fi`,
        `if ! command -v ttyd >/dev/null 2>&1; then`,
        `  echo "downloading static ttyd ${TTYD_VERSION}...";`,
        `  ARCH=$(uname -m);`,
        `  case "$ARCH" in x86_64) TBIN=ttyd.x86_64;; aarch64|arm64) TBIN=ttyd.aarch64;; armv7l|armv6l) TBIN=ttyd.arm;; *) TBIN=ttyd.x86_64;; esac;`,
        `  mkdir -p "$HOME/.local/bin";`,
        `  URL="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/$TBIN";`,
        `  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o "$HOME/.local/bin/ttyd"; elif command -v wget >/dev/null 2>&1; then wget -qO "$HOME/.local/bin/ttyd" "$URL"; fi;`,
        `  chmod +x "$HOME/.local/bin/ttyd" 2>/dev/null || true;`,
        `  export PATH="$HOME/.local/bin:$PATH";`,
        `fi`,
        `if ! command -v ttyd >/dev/null 2>&1; then echo "could not install ttyd automatically — install it manually and retry"; exit 127; fi`,
        `echo "starting ttyd on :8080";`,
        `exec ttyd -W -p 8080 -c '${safeUser}:${safePass}' claude`,
      ].join('\n');

      serviceAbortRef.current?.abort();
      const { controller, started } = api.startBackgroundService(
        spriteName,
        `wisp-ttyd-${Date.now().toString(36)}`,
        { cmd: 'bash', args: ['-lc', inner], http_port: 8080 },
        (event) => {
          if (event.type === 'stdout' || event.type === 'stderr') {
            appendLog(`ttyd: ${(event.data ?? '').trim()}`);
          } else if (event.type === 'exit') {
            appendLog(`ttyd exited (code ${event.exit_code ?? '?'})`);
          } else if (event.type === 'error' && event.data) {
            appendLog(`ttyd error: ${event.data}`);
          }
        }
      );
      serviceAbortRef.current = controller;
      await started;

      setBootstrapping(false);
      progressBucketRef.current = -1;
      setLoading(true);
      setIsConnected(true);
      appendLog(`connect: starting ${sprite.url}`);
    } catch (err: any) {
      setBootstrapping(false);
      const message = err?.message ?? 'bootstrap failed';
      setError(`Bootstrap failed: ${message}`);
      appendLog(`bootstrap error: ${message}`);
    }
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setLoading(false);
    setError(null);
    appendLog('disconnect: closed by user');
  };

  const handleHttpError = (event: WebViewHttpErrorEvent) => {
    const { statusCode, description, url } = event.nativeEvent;
    appendLog(`http-error: ${statusCode} ${url ?? ''} ${description ?? ''}`.trim());

    if (statusCode === 401) {
      setError('Authentication failed. Check username/password.');
      setIsConnected(false);
    } else {
      setError(`HTTP error ${statusCode}`);
    }

    setLoading(false);
  };

  const handleLoadError = (event: WebViewErrorEvent) => {
    const { code, description, domain, url } = event.nativeEvent;
    appendLog(`load-error: code=${code ?? 'n/a'} domain=${domain ?? 'n/a'} url=${url ?? 'n/a'} desc=${description ?? 'n/a'}`);
    setError('Could not connect. Check host URL and network.');
    setIsConnected(false);
    setLoading(false);
  };

  const handleLoadStart = (event: WebViewNavigationEvent) => {
    appendLog(`load-start: ${event.nativeEvent.url ?? 'unknown-url'}`);
    setLoading(true);
  };

  const handleLoad = (event: WebViewNavigationEvent) => {
    appendLog(`load-success: ${event.nativeEvent.url ?? 'unknown-url'}`);
    setLoading(false);
  };

  const handleLoadEnd = (event: WebViewNavigationEvent | WebViewErrorEvent) => {
    appendLog(`load-end: ${event.nativeEvent.url ?? 'unknown-url'}`);
    setLoading(false);
  };

  const handleLoadProgress = (event: WebViewProgressEvent) => {
    const progress = Math.round(event.nativeEvent.progress * 100);
    const bucket = Math.floor(progress / 10);

    if (bucket > progressBucketRef.current) {
      progressBucketRef.current = bucket;
      appendLog(`load-progress: ${progress}%`);
    }

    if (progress >= 85) {
      setLoading(false);
    }
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;

    try {
      const parsed = JSON.parse(data) as { source?: string; type?: string; payload?: Record<string, unknown> };
      if (parsed?.source === 'ttyd') {
        appendLog(`web:${parsed.type ?? 'message'} ${JSON.stringify(parsed.payload ?? {})}`);
        return;
      }
    } catch {
      // Fall through to raw log.
    }

    appendLog(`web:message ${data}`);
  };

  const handleShouldStartLoad = (request: { url?: string }) => {
    appendLog(`should-start: ${request.url ?? 'unknown-url'}`);
    return true;
  };

  const handleNavigationStateChange = (navState: WebViewNavState) => {
    appendLog(`navigation: url=${navState.url ?? 'n/a'} loading=${String(navState.loading)} title=${navState.title ?? ''}`.trim());
  };

  const renderLogs = () => {
    if (!showLogs) return null;

    return (
      <View style={styles.logsContainer}>
        <View style={styles.logsHeader}>
          <Text style={styles.logsTitle}>Debug logs ({logs.length})</Text>
          <View style={styles.logsActions}>
            <Pressable onPress={copyLogs} style={styles.logsActionButton}>
              <Text style={styles.logsActionText}>Copy</Text>
            </Pressable>
            <Pressable onPress={clearLogs} style={styles.logsActionButton}>
              <Text style={styles.logsActionText}>Clear</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView style={styles.logsScroll} contentContainerStyle={styles.logsScrollContent}>
          {logs.length ? (
            logs.map((entry, index) => (
              <Text key={`${entry.timestamp}-${index}`} style={styles.logsLine}>
                {new Date(entry.timestamp).toISOString()} {entry.message}
              </Text>
            ))
          ) : (
            <Text style={styles.logsEmpty}>No logs yet.</Text>
          )}
        </ScrollView>
      </View>
    );
  };

  if (isConnected) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1b26" />
        <SafeAreaView style={styles.container} edges={['top']}>
          <View style={styles.topBar}>
            <Pressable onPress={handleDisconnect} style={styles.disconnectBtn}>
              <Text style={styles.disconnectText}>Disconnect</Text>
            </Pressable>
            <Text style={styles.topBarTitle} numberOfLines={1}>
              {displayUrl}
            </Text>
            <Pressable onPress={() => setShowLogs((value) => !value)} style={styles.logsToggleBtn}>
              <Text style={styles.logsToggleText}>{showLogs ? 'Hide Logs' : 'Show Logs'}</Text>
            </Pressable>
          </View>

          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#7aa2f7" />
              <Text style={styles.loadingText}>Connecting to terminal...</Text>
            </View>
          )}

          {WebViewComponent ? (
            <WebViewComponent
              ref={webViewRef}
              source={{ uri: authedUrl, headers: authHeaders }}
              basicAuthCredential={{ username, password }}
              onShouldStartLoadWithRequest={handleShouldStartLoad}
              onHttpError={handleHttpError}
              onError={handleLoadError}
              onLoadStart={handleLoadStart}
              onLoad={handleLoad}
              onLoadEnd={handleLoadEnd}
              onLoadProgress={handleLoadProgress}
              onNavigationStateChange={handleNavigationStateChange}
              onMessage={handleMessage}
              injectedJavaScript={injectedJS}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              mixedContentMode="compatibility"
              allowsInlineMediaPlayback
              style={styles.webview}
            />
          ) : (
            <View style={styles.missingModuleContainer}>
              <Text style={styles.missingModuleTitle}>WebView Native Module Missing</Text>
              <Text style={styles.missingModuleText}>
                Install `react-native-webview` and rebuild the iOS dev client to use this screen.
              </Text>
            </View>
          )}
          {renderLogs()}
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1b26" />
      <SafeAreaView style={styles.container} edges={['top']}>
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.loginContainer}>
            <Text style={styles.logo}>ttyd</Text>
            <Text style={styles.subtitle}>
              {spriteName ? spriteName : 'Web terminal in your pocket'}
            </Text>

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.label}>Host URL</Text>
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder={DEFAULT_HOST}
              placeholderTextColor="#565f89"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            <Text style={styles.label}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder={DEFAULT_USER}
              placeholderTextColor="#565f89"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="********"
              placeholderTextColor="#565f89"
              secureTextEntry
            />

            {spriteName ? (
              <Pressable
                style={[styles.connectBtn, bootstrapping && styles.btnDisabled]}
                onPress={handleBootstrap}
                disabled={bootstrapping}
              >
                {bootstrapping ? (
                  <ActivityIndicator color="#1a1b26" />
                ) : (
                  <Text style={styles.connectBtnText}>Start ttyd in this sprite</Text>
                )}
              </Pressable>
            ) : null}

            <Pressable
              style={[styles.connectBtn, spriteName ? styles.secondaryBtn : null]}
              onPress={handleConnect}
            >
              <Text style={[styles.connectBtnText, spriteName ? styles.secondaryBtnText : null]}>
                {spriteName ? 'Connect manually' : 'Connect'}
              </Text>
            </Pressable>

            <Text style={styles.hint}>
              {spriteName
                ? '“Start ttyd” opens the sprite URL (auth: public), installs ttyd if missing, runs it on port 8080 in your working directory, then connects.'
                : 'Start a ttyd server inside the sprite on port 8080 — the sprite URL proxies to it:'}
              {'\n'}
              <Text style={styles.code}>ttyd -W -c user:pass -p 8080 claude</Text>
            </Text>

            <Pressable onPress={() => setShowLogs((value) => !value)} style={styles.loginLogsToggleBtn}>
              <Text style={styles.logsToggleText}>{showLogs ? 'Hide Logs' : 'Show Logs'}</Text>
            </Pressable>
            {renderLogs()}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1b26',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#16161e',
    borderBottomWidth: 1,
    borderBottomColor: '#292e42',
  },
  disconnectBtn: {
    paddingVertical: 4,
    paddingRight: 12,
  },
  disconnectText: {
    color: '#7aa2f7',
    fontSize: 14,
    fontWeight: '600',
  },
  topBarTitle: {
    flex: 1,
    color: '#565f89',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  logsToggleBtn: {
    paddingVertical: 4,
    paddingLeft: 8,
  },
  logsToggleText: {
    color: '#7aa2f7',
    fontSize: 13,
    fontWeight: '600',
  },
  webview: {
    flex: 1,
    backgroundColor: '#1a1b26',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: '#1a1b26ee',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#a9b1d6',
    marginTop: 12,
    fontSize: 14,
  },
  loginContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logo: {
    color: '#7aa2f7',
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  subtitle: {
    color: '#565f89',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 36,
    marginTop: 4,
  },
  label: {
    color: '#a9b1d6',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    backgroundColor: '#16161e',
    borderWidth: 1,
    borderColor: '#292e42',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#c0caf5',
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  connectBtn: {
    backgroundColor: '#7aa2f7',
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 28,
    alignItems: 'center',
  },
  connectBtnText: {
    color: '#1a1b26',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#7aa2f7',
    marginTop: 10,
  },
  secondaryBtnText: {
    color: '#7aa2f7',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  hint: {
    color: '#565f89',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
  loginLogsToggleBtn: {
    alignItems: 'center',
    marginTop: 14,
  },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#9ece6a',
  },
  logsContainer: {
    borderTopWidth: 1,
    borderTopColor: '#292e42',
    backgroundColor: '#11111a',
    maxHeight: 220,
  },
  logsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  logsTitle: {
    color: '#a9b1d6',
    fontSize: 12,
    fontWeight: '600',
  },
  logsActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logsActionButton: {
    paddingVertical: 2,
  },
  logsActionText: {
    color: '#7aa2f7',
    fontSize: 12,
    fontWeight: '600',
  },
  logsScroll: {
    flex: 1,
  },
  logsScrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  logsLine: {
    color: '#c0caf5',
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  },
  logsEmpty: {
    color: '#565f89',
    fontSize: 12,
    paddingVertical: 8,
  },
  missingModuleContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  missingModuleTitle: {
    color: '#f7768e',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  missingModuleText: {
    color: '#c0caf5',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#f7768e20',
    borderWidth: 1,
    borderColor: '#f7768e44',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  errorText: {
    color: '#f7768e',
    fontSize: 13,
    textAlign: 'center',
  },
});
