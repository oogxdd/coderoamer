/**
 * AddConnectionSheet — the "Add" chooser and the Add Custom VPS flow (§3.2).
 *
 *   choose ─┬─ Add Sprite      → name → onCreateSprite (existing flow)
 *           └─ Add Custom VPS ─┬─ Existing machine → tunnel + paste baseUrl/token
 *                              └─ AWS (create new)  → creds + region + launch
 *
 * Custom connections are native-only (§3.3); the caller only mounts this on
 * native. AWS launch pre-generates the AGENT_TOKEN and stores the connection
 * with its EC2 ref; the tunnel URL is filled in once the box is reachable.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { useConnections } from '@/contexts/ConnectionsContext';
import { newConnectionId, newAgentToken } from '@/services/connections';
import { normalizeBaseUrl, TunnelKind } from '@/models/connection';
import {
  saveAwsCreds,
  launchInstance,
  ALLOWED_INSTANCE_TYPES,
  DEFAULT_INSTANCE_TYPE,
  AllowedInstanceType,
} from '@/services/aws';

type Mode = 'choose' | 'sprite' | 'vps-backing' | 'existing' | 'aws';

const REPO = 'https://github.com/oogxdd/sprites-rn-manager';

function installOneLiner(tunnel: TunnelKind): string {
  return `git clone ${REPO} && cd sprites-rn-manager/remote-agent && bash install.sh --tunnel=${tunnel}`;
}

interface Props {
  onClose: () => void;
  onCreateSprite: (name: string) => Promise<void>;
}

export function AddConnectionSheet({ onClose, onCreateSprite }: Props) {
  const colors = useTheme();
  const { addConnection } = useConnections();
  const [mode, setMode] = useState<Mode>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // sprite
  const [spriteName, setSpriteName] = useState('');
  // existing machine
  const [tunnel, setTunnel] = useState<TunnelKind>('tailscale');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  // aws
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [instanceType, setInstanceType] = useState<AllowedInstanceType>(DEFAULT_INSTANCE_TYPE);
  const [imageId, setImageId] = useState('');
  const [tsAuthKey, setTsAuthKey] = useState('');

  const reset = () => {
    setError(undefined);
    setBusy(false);
  };

  const handleCreateSprite = async () => {
    const trimmed = spriteName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmed) return setError('Please enter a name');
    setBusy(true);
    setError(undefined);
    try {
      await onCreateSprite(trimmed);
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'Failed to create sprite');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveExisting = async () => {
    const url = normalizeBaseUrl(baseUrl);
    if (!url) return setError('Enter the machine base URL');
    if (!/^https?:\/\//i.test(url)) return setError('Base URL must start with http:// or https://');
    if (!token.trim()) return setError('Enter the AGENT_TOKEN');
    setBusy(true);
    setError(undefined);
    try {
      await addConnection({
        id: newConnectionId(),
        backing: 'existing',
        name: name.trim() || 'Custom VPS',
        baseUrl: url,
        token: token.trim(),
        tunnel,
      });
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'Failed to add connection');
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchAws = async () => {
    if (!accessKeyId.trim() || !secretAccessKey.trim()) return setError('Enter your IAM access key and secret');
    if (!region.trim()) return setError('Enter a region');
    if (!imageId.trim()) return setError('Enter an AMI id for this region');
    setBusy(true);
    setError(undefined);
    try {
      const creds = { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
      await saveAwsCreds(creds);
      const agentToken = newAgentToken();
      const displayName = name.trim() || `aws ${region.trim()}`;
      const { instanceId } = await launchInstance(
        { creds, region: region.trim() },
        {
          imageId: imageId.trim(),
          instanceType,
          agentToken,
          tunnel,
          tsAuthKey: tsAuthKey.trim() || undefined,
          name: displayName,
        }
      );
      // The tunnel URL isn't known until the box boots + the tunnel is up. Store
      // the connection now (with its EC2 ref + token) so it's recoverable; the
      // user fills in baseUrl from the dashboard once it's reachable.
      await addConnection({
        id: newConnectionId(),
        backing: 'aws-ec2',
        name: displayName,
        token: agentToken,
        tunnel,
        aws: { region: region.trim(), instanceId, instanceType },
      });
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  const input = (props: React.ComponentProps<typeof TextInput>) => (
    <TextInput
      placeholderTextColor={colors.textSecondary}
      autoCapitalize="none"
      autoCorrect={false}
      editable={!busy}
      {...props}
      style={[
        styles.input,
        { color: colors.text, backgroundColor: colors.inputBackground, borderColor: colors.border },
      ]}
    />
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {mode === 'choose' && (
            <>
              <Text style={[styles.title, { color: colors.text }]}>Add</Text>
              <BigButton label="Add Sprite" hint="Create a Fly.io Sprite VM" colors={colors} onPress={() => { reset(); setMode('sprite'); }} />
              <BigButton label="Add Custom VPS" hint="AWS, a home server, or any Linux box" colors={colors} onPress={() => { reset(); setMode('vps-backing'); }} />
            </>
          )}

          {mode === 'sprite' && (
            <>
              <Header title="New Sprite" onBack={() => setMode('choose')} colors={colors} />
              {input({ placeholder: 'sprite-name', value: spriteName, onChangeText: setSpriteName, autoFocus: true })}
              <PrimaryButton label="Create" busy={busy} disabled={!spriteName.trim()} colors={colors} onPress={handleCreateSprite} />
            </>
          )}

          {mode === 'vps-backing' && (
            <>
              <Header title="Add Custom VPS" onBack={() => setMode('choose')} colors={colors} />
              <BigButton label="Existing machine" hint="A home server or any VPS already running remote-agent" colors={colors} onPress={() => { reset(); setMode('existing'); }} />
              <BigButton label="AWS (create new)" hint="Launch a new EC2 instance the app manages" colors={colors} onPress={() => { reset(); setMode('aws'); }} />
            </>
          )}

          {mode === 'existing' && (
            <>
              <Header title="Existing machine" onBack={() => setMode('vps-backing')} colors={colors} />
              <Text style={[styles.label, { color: colors.textSecondary }]}>Exposure</Text>
              <Segmented
                options={[
                  { value: 'tailscale', label: 'Tailscale' },
                  { value: 'cloudflare', label: 'Cloudflare' },
                  { value: 'none', label: 'LAN only' },
                ]}
                value={tunnel}
                onChange={(v) => setTunnel(v as TunnelKind)}
                colors={colors}
              />
              <Text style={[styles.label, { color: colors.textSecondary }]}>
                Run this on the machine, then paste the URL + token it prints:
              </Text>
              <Pressable
                onPress={() => Clipboard.setStringAsync(installOneLiner(tunnel))}
                style={[styles.code, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}
              >
                <Text style={[styles.codeText, { color: colors.text }]} selectable>
                  {installOneLiner(tunnel)}
                </Text>
                <Text style={[styles.copyHint, { color: colors.tint }]}>Tap to copy</Text>
              </Pressable>
              {input({ placeholder: 'Display name (optional)', value: name, onChangeText: setName })}
              {input({ placeholder: tunnel === 'none' ? 'http://192.168.x.y:8765' : 'https://your-machine.ts.net', value: baseUrl, onChangeText: setBaseUrl, keyboardType: 'url' })}
              {input({ placeholder: 'AGENT_TOKEN', value: token, onChangeText: setToken })}
              <PrimaryButton label="Add machine" busy={busy} disabled={!baseUrl.trim() || !token.trim()} colors={colors} onPress={handleSaveExisting} />
            </>
          )}

          {mode === 'aws' && (
            <>
              <Header title="AWS (create new)" onBack={() => setMode('vps-backing')} colors={colors} />
              <Text style={[styles.label, { color: colors.textSecondary }]}>
                Paste an IAM access key scoped to the policy in docs/aws-iam-policy.json.
              </Text>
              {input({ placeholder: 'AWS Access Key ID', value: accessKeyId, onChangeText: setAccessKeyId })}
              {input({ placeholder: 'AWS Secret Access Key', value: secretAccessKey, onChangeText: setSecretAccessKey, secureTextEntry: true })}
              {input({ placeholder: 'Region (e.g. us-east-1)', value: region, onChangeText: setRegion })}
              <Text style={[styles.label, { color: colors.textSecondary }]}>Instance type</Text>
              <Segmented
                options={ALLOWED_INSTANCE_TYPES.map((t) => ({ value: t, label: t }))}
                value={instanceType}
                onChange={(v) => setInstanceType(v as AllowedInstanceType)}
                colors={colors}
              />
              {input({ placeholder: 'AMI id for this region (ami-…)', value: imageId, onChangeText: setImageId })}
              {input({ placeholder: 'Display name (optional)', value: name, onChangeText: setName })}
              <Text style={[styles.label, { color: colors.textSecondary }]}>Exposure (Tailscale recommended)</Text>
              <Segmented
                options={[
                  { value: 'tailscale', label: 'Tailscale' },
                  { value: 'cloudflare', label: 'Cloudflare' },
                ]}
                value={tunnel === 'none' ? 'tailscale' : tunnel}
                onChange={(v) => setTunnel(v as TunnelKind)}
                colors={colors}
              />
              {tunnel === 'tailscale' &&
                input({ placeholder: 'Tailscale auth key (tskey-…, for headless join)', value: tsAuthKey, onChangeText: setTsAuthKey })}
              <PrimaryButton label="Launch instance" busy={busy} disabled={!accessKeyId.trim() || !secretAccessKey.trim() || !imageId.trim()} colors={colors} onPress={handleLaunchAws} />
              <Text style={[styles.hintSmall, { color: colors.textSecondary }]}>
                The instance boots and installs remote-agent automatically. Add its tunnel URL to the
                connection once it is reachable.
              </Text>
            </>
          )}

          {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

type Colors = ReturnType<typeof useTheme>;

function Header({ title, onBack, colors }: { title: string; onBack: () => void; colors: Colors }) {
  return (
    <View style={styles.headerRow}>
      <Pressable onPress={onBack} hitSlop={10}>
        <Text style={[styles.back, { color: colors.tint }]}>‹ Back</Text>
      </Pressable>
      <Text style={[styles.title, { color: colors.text, marginBottom: 0 }]}>{title}</Text>
      <View style={{ width: 44 }} />
    </View>
  );
}

function BigButton({ label, hint, onPress, colors }: { label: string; hint: string; onPress: () => void; colors: Colors }) {
  return (
    <Pressable onPress={onPress} style={[styles.bigButton, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
      <Text style={[styles.bigButtonLabel, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.bigButtonHint, { color: colors.textSecondary }]}>{hint}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, busy, disabled, onPress, colors }: { label: string; busy: boolean; disabled?: boolean; onPress: () => void; colors: Colors }) {
  return (
    <Pressable
      style={[styles.primary, { backgroundColor: colors.tint, opacity: disabled || busy ? 0.5 : 1 }]}
      onPress={onPress}
      disabled={disabled || busy}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  );
}

function Segmented({ options, value, onChange, colors }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; colors: Colors }) {
  return (
    <View style={[styles.segmented, { borderColor: colors.border }]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.segment, active && { backgroundColor: colors.tint }]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.segmentText, { color: active ? '#fff' : colors.text }]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: Spacing.xl, paddingBottom: 40, maxHeight: '88%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.lg },
  back: { fontSize: FontSize.md, fontWeight: '600', width: 44 },
  title: { fontSize: FontSize.xl, fontWeight: '700', marginBottom: Spacing.lg },
  label: { fontSize: FontSize.sm, marginTop: Spacing.md, marginBottom: Spacing.sm },
  input: { fontSize: FontSize.md, padding: Spacing.md, borderRadius: 10, borderWidth: 1, marginBottom: Spacing.sm },
  bigButton: { padding: Spacing.lg, borderRadius: 12, borderWidth: 1, marginBottom: Spacing.md },
  bigButtonLabel: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: 4 },
  bigButtonHint: { fontSize: FontSize.sm },
  primary: { paddingVertical: Spacing.md, borderRadius: 10, alignItems: 'center', justifyContent: 'center', minHeight: 48, marginTop: Spacing.md },
  primaryText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, overflow: 'hidden', marginBottom: Spacing.sm },
  segment: { flex: 1, paddingVertical: Spacing.sm, alignItems: 'center' },
  segmentText: { fontSize: FontSize.sm, fontWeight: '600' },
  code: { padding: Spacing.md, borderRadius: 10, borderWidth: 1, marginBottom: Spacing.md },
  codeText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: FontSize.sm },
  copyHint: { fontSize: FontSize.xs, marginTop: Spacing.sm, fontWeight: '600' },
  error: { fontSize: FontSize.sm, marginTop: Spacing.md },
  hintSmall: { fontSize: FontSize.xs, marginTop: Spacing.md, lineHeight: 16 },
});
