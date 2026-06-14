import { Button, Card, Input } from "@heroui/react";
import { Link, useNavigate } from "@tanstack/react-router";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { setCredential } from "@/lib/credential";
import { disconnectSocket, refreshBootstrap } from "@/lib/socket";
import { toast } from "@/lib/toast";

type RegistrationSetup = {
  setupToken: string;
  secret: string;
  otpAuthUrl: string;
};

export function RegisterScreen() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [setup, setSetup] = useState<RegistrationSetup>();
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!setup) {
      return;
    }
    void QRCode.toDataURL(setup.otpAuthUrl, { width: 220, margin: 1 }).then(
      setQr
    );
  }, [setup]);

  async function start() {
    if (!username.trim()) {
      return;
    }
    setLoading(true);
    try {
      setSetup(
        await post<RegistrationSetup>("/api/identity/register/start", {
          username,
        })
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Registration failed"
      );
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!setup) {
      return;
    }
    setLoading(true);
    try {
      const result = await post<{
        credentialToken: string;
        recoveryCode: string;
      }>("/api/identity/register/confirm", {
        setupToken: setup.setupToken,
        code,
      });
      setCredential(result.credentialToken);
      disconnectSocket();
      setRecoveryCode(result.recoveryCode);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Verification failed"
      );
    } finally {
      setLoading(false);
    }
  }

  async function finish() {
    await refreshBootstrap();
    await navigate({ to: "/" });
  }

  return (
    <IdentityLayout>
      {setup || recoveryCode ? null : (
        <div className="space-y-4">
          <p className="text-default-500 text-sm">
            Choose a username for this device.
          </p>

          <Input
            aria-label="Username"
            autoFocus
            fullWidth
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username"
            value={username}
            variant="secondary"
          />
          <Button
            fullWidth
            // isDisabled={!username.trim()}
            isPending={loading}
            onPress={start}
            variant="primary"
          >
            Register
          </Button>
          <p className="text-center text-default-500 text-sm">
            Already registered?{" "}
            <Link className="font-medium text-accent" to="/recover">
              Recover identity
            </Link>
          </p>
        </div>
      )}
      {setup && !recoveryCode ? (
        <div className="space-y-4">
          <p className="text-default-500 text-sm">
            Scan this QR code with your authenticator app.
          </p>
          {qr ? (
            <img
              alt="Authenticator QR code"
              className="mx-auto size-52"
              src={qr}
            />
          ) : null}
          <div className="rounded-2xl bg-default-100 p-3 text-center font-mono text-sm">
            {setup.secret}
          </div>
          <Input
            aria-label="Authenticator code"
            inputMode="numeric"
            onChange={(event) => setCode(event.target.value)}
            placeholder="6-digit code"
            value={code}
            variant="secondary"
          />
          <Button
            fullWidth
            isDisabled={code.length !== 6}
            isPending={loading}
            onPress={confirm}
            variant="primary"
          >
            Verify
          </Button>
        </div>
      ) : null}
      {recoveryCode ? (
        <div className="space-y-5">
          <p className="text-default-500 text-sm">
            Save this single-use recovery code. It will not be shown again.
          </p>
          <div className="rounded-2xl bg-accent-soft p-5 text-center font-mono font-semibold text-accent-soft-foreground text-xl tracking-wider">
            {recoveryCode}
          </div>
          <label
            className="flex items-center gap-3 text-sm"
            htmlFor="recovery-code-saved"
          >
            <Input
              checked={saved}
              className="size-4"
              id="recovery-code-saved"
              onChange={(event) => setSaved(event.target.checked)}
              type="checkbox"
              variant="secondary"
            />
            I saved this recovery code
          </label>
          <Button
            fullWidth
            isDisabled={!saved}
            onPress={finish}
            variant="primary"
          >
            Open Quick Send
          </Button>
        </div>
      ) : null}
    </IdentityLayout>
  );
}

export function RecoverScreen() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function start() {
    if (!username.trim()) {
      return;
    }
    setLoading(true);
    try {
      const result = await post<{ challengeId: string }>(
        "/api/identity/recover/start",
        { username }
      );
      setChallengeId(result.challengeId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recovery failed");
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!code.trim()) {
      return;
    }
    setLoading(true);
    try {
      const result = await post<{ credentialToken: string }>(
        "/api/identity/recover/confirm",
        { challengeId, code }
      );
      setCredential(result.credentialToken);
      disconnectSocket();
      await refreshBootstrap();
      await navigate({ to: "/" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recovery failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <IdentityLayout>
      <div className="space-y-4">
        <p className="text-default-500 text-sm">Use your authenticator code.</p>
        <Input
          aria-label="Username"
          autoFocus
          fullWidth
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          value={username}
          variant="secondary"
        />

        <Input
          aria-label="Verification code"
          autoFocus
          fullWidth
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="Verification code"
          value={code}
          variant="secondary"
        />

        <Button
          fullWidth
          // isDisabled={challengeId ? !code.trim() : !username.trim()}
          isPending={loading}
          onPress={challengeId ? confirm : start}
          variant="primary"
        >
          {"Sign In"}
        </Button>
        <p className="text-center text-default-500 text-sm">
          New device?{" "}
          <Link className="font-medium text-accent" to="/setup">
            Create identity
          </Link>
        </p>
      </div>
    </IdentityLayout>
  );
}

function IdentityLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-blue-50 px-5 py-10">
      <Card className="w-full max-w-md rounded-3xl bg-white p-6 shadow-sm sm:p-8">
        <Card.Header>
          <div className="flex w-full justify-center space-y-1">
            <Card.Title className="text-2xl">Quick Send</Card.Title>
          </div>
        </Card.Header>
        <Card.Content className="pt-5">{children}</Card.Content>
      </Card>
    </main>
  );
}
