import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useTheme } from '@/theme/ThemeProvider';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/Banner';
import { Card } from '@/components/ui/Card';
import { normalizeServerUrl } from '@/utils/url';
import { probeServer, type ProbeResult } from '@/services/api/server-check';
import { ApiClient } from '@/services/api/client';
import { FetchTransport } from '@/services/api/transport.rn';

export default function ServerSetupScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { activeServer, setServer, disconnectServer } = useAuth();

  const [urlInput, setUrlInput] = useState(activeServer?.url ?? '');
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [ackHttp, setAckHttp] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);

  const handleTestConnection = async () => {
    setValidationError(null);
    setProbeResult(null);

    const check = normalizeServerUrl(urlInput);
    if (!check.ok) {
      setValidationError(check.message);
      return;
    }

    if (check.requiresAcknowledgement && !ackHttp) {
      setNeedsAck(true);
      setValidationError('Plain HTTP is insecure over the local network. Please acknowledge before connecting.');
      return;
    }

    setIsProbing(true);
    try {
      const client = new ApiClient({
        baseUrl: check.normalized,
        transport: new FetchTransport(),
        defaultTimeoutMs: 15_000,
      });

      const res = await probeServer(client);
      setProbeResult(res);

      if (res.status === 'ok' || res.status === 'legacy-ok') {
        // Successful probe
        setUrlInput(check.normalized);
      }
    } catch (err) {
      setProbeResult({
        status: 'unreachable',
        code: 'network',
        message: err instanceof Error ? err.message : 'Could not contact the server.',
      });
    } finally {
      setIsProbing(false);
    }
  };

  const handleSaveAndContinue = async () => {
    const check = normalizeServerUrl(urlInput);
    if (!check.ok) {
      setValidationError(check.message);
      return;
    }

    const hasCapabilities =
      probeResult && probeResult.status === 'ok'
        ? Boolean(probeResult.info?.capabilities.memoClientId)
        : false;

    const serverName =
      probeResult && probeResult.status === 'ok'
        ? probeResult.info?.name ?? 'Pocket Diary'
        : 'Pocket Diary';

    await setServer({
      url: check.normalized,
      serverKey: check.normalized,
      name: serverName,
      isLegacy: probeResult?.status === 'legacy-ok',
      capabilities: { memoClientId: hasCapabilities },
      addedAt: Date.now(),
    });

    router.replace('/auth/login');
  };

  const handleDisconnect = async () => {
    await disconnectServer();
    setUrlInput('');
    setProbeResult(null);
  };

  const isProbeSuccess = probeResult?.status === 'ok' || probeResult?.status === 'legacy-ok';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.bg }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { padding: theme.spacing.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header Branding */}
          <View style={styles.brandRow}>
            <View style={[styles.logoIcon, { backgroundColor: theme.colors.primarySoft }]}>
              <Ionicons name="book-outline" size={36} color={theme.colors.primary} />
            </View>
            <Text
              style={[
                styles.appTitle,
                {
                  color: theme.colors.text,
                  fontSize: theme.font.title1,
                  fontWeight: theme.weight.bold,
                },
              ]}
            >
              Pocket Diary
            </Text>
            <Text
              style={[
                styles.subtitle,
                {
                  color: theme.colors.textSubtle,
                  fontSize: theme.font.body,
                  marginTop: theme.spacing.xs,
                  textAlign: 'center',
                },
              ]}
            >
              Connect to your self-hosted server to synchronize your notes, checklists, and reminders.
            </Text>
          </View>

          {/* Current Server Notice (if already configured) */}
          {activeServer ? (
            <Card style={{ marginBottom: theme.spacing.lg }}>
              <View style={styles.activeServerRow}>
                <Ionicons name="server-outline" size={20} color={theme.colors.primary} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.caption }}>
                    CURRENT SERVER
                  </Text>
                  <Text style={{ color: theme.colors.text, fontWeight: theme.weight.semibold }}>
                    {activeServer.url}
                  </Text>
                </View>
                <Button
                  title="Disconnect"
                  size="sm"
                  variant="ghost"
                  onPress={handleDisconnect}
                />
              </View>
            </Card>
          ) : null}

          {/* Setup Form */}
          <Card style={{ marginBottom: theme.spacing.lg }}>
            <Text
              style={[
                styles.sectionTitle,
                {
                  color: theme.colors.text,
                  fontSize: theme.font.headline,
                  fontWeight: theme.weight.bold,
                  marginBottom: theme.spacing.sm,
                },
              ]}
            >
              Server Address
            </Text>
            <Text
              style={[
                styles.sectionDesc,
                {
                  color: theme.colors.textSubtle,
                  fontSize: theme.font.callout,
                  marginBottom: theme.spacing.md,
                },
              ]}
            >
              Enter the URL of your instance (e.g. https://notes.yourdomain.com or http://192.168.1.50:3000).
            </Text>

            <TextField
              placeholder="https://notes.example.com"
              value={urlInput}
              onChangeText={(text) => {
                setUrlInput(text);
                setProbeResult(null);
                setValidationError(null);
                setNeedsAck(false);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              leftIcon="globe-outline"
              clearable
              error={validationError}
            />

            {needsAck ? (
              <Pressable
                onPress={() => setAckHttp((prev) => !prev)}
                style={[
                  styles.ackRow,
                  {
                    backgroundColor: theme.colors.warningSoft,
                    borderColor: theme.colors.warning,
                    padding: theme.spacing.md,
                    borderRadius: theme.radii.sm,
                    marginBottom: theme.spacing.md,
                  },
                ]}
              >
                <Ionicons
                  name={ackHttp ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={theme.colors.warning}
                  style={{ marginRight: 8 }}
                />
                <Text style={{ color: theme.colors.text, fontSize: theme.font.callout, flex: 1 }}>
                  Allow unencrypted connection over local HTTP. (Only recommended for private home LANs).
                </Text>
              </Pressable>
            ) : null}

            <Button
              title="Test Connection"
              variant={isProbeSuccess ? 'secondary' : 'primary'}
              onPress={handleTestConnection}
              loading={isProbing}
              disabled={!urlInput.trim()}
              icon={<Ionicons name="flash-outline" size={18} color={isProbeSuccess ? theme.colors.text : '#FFFFFF'} />}
            />
          </Card>

          {/* Probe Status Feedback */}
          {probeResult ? (
            <View style={{ marginBottom: theme.spacing.lg }}>
              {probeResult.status === 'ok' ? (
                <Banner
                  variant="success"
                  title="Connected Successfully"
                  message={`Found Pocket Diary v${probeResult.info?.version}. Server capabilities verified (idempotent note creation supported).`}
                />
              ) : probeResult.status === 'legacy-ok' ? (
                <Banner
                  variant="warning"
                  title="Connected to Older Server"
                  message="Server is operational (/health responded ok). Note sync is supported with client-side fallback deduplication."
                />
              ) : (
                <Banner
                  variant="error"
                  title={probeResult.status === 'unreachable' ? 'Server Unreachable' : 'Incompatible Server'}
                  message={'message' in probeResult ? probeResult.message : 'Could not contact server.'}
                />
              )}
            </View>
          ) : null}

          {/* Connect Action Button */}
          {isProbeSuccess ? (
            <Button
              title="Continue to Sign In"
              variant="primary"
              size="lg"
              onPress={handleSaveAndContinue}
              icon={<Ionicons name="arrow-forward" size={20} color="#FFFFFF" />}
              style={{ marginTop: theme.spacing.sm }}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  brandRow: {
    alignItems: 'center',
    marginBottom: 28,
  },
  logoIcon: {
    width: 68,
    height: 68,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  appTitle: {
    letterSpacing: -0.5,
  },
  subtitle: {
    maxWidth: 320,
  },
  activeServerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionTitle: {
    letterSpacing: -0.2,
  },
  sectionDesc: {
    lineHeight: 20,
  },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
});
