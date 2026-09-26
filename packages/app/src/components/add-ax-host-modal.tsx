import {
  DEFAULT_AX_ATESPACE,
  DEFAULT_AX_EGRESS_HOSTS,
  DEFAULT_AX_IMAGE,
  DEFAULT_AX_NAMESPACE,
} from "@getpaseo/protocol/managed-hosts-ax";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostMutations } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

const FLEX_ONE_STYLE = { flex: 1 } as const;

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));

export interface AddAxHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: { profile: HostProfile; serverId: string }) => void;
}

export function AddAxHostModal({ visible, onClose, onCancel, onSaved }: AddAxHostModalProps) {
  const { t } = useTranslation();
  const { provisionAxHost } = useHostMutations();
  const [taskName, setTaskName] = useState("");
  const [context, setContext] = useState("");
  const [namespace, setNamespace] = useState(DEFAULT_AX_NAMESPACE);
  const [atespace, setAtespace] = useState(DEFAULT_AX_ATESPACE);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [image, setImage] = useState(DEFAULT_AX_IMAGE);
  const [egressHosts, setEgressHosts] = useState(DEFAULT_AX_EGRESS_HOSTS.join(", "));
  const [cpuRequest, setCpuRequest] = useState("");
  const [memoryRequest, setMemoryRequest] = useState("");
  const [cpuLimit, setCpuLimit] = useState("");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [formVersion, setFormVersion] = useState(0);

  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.agentExecutor.title") }), [t]);

  const clear = useCallback(() => {
    setTaskName("");
    setContext("");
    setNamespace(DEFAULT_AX_NAMESPACE);
    setAtespace(DEFAULT_AX_ATESPACE);
    setRepo("");
    setBranch("");
    setImage(DEFAULT_AX_IMAGE);
    setEgressHosts(DEFAULT_AX_EGRESS_HOSTS.join(", "));
    setCpuRequest("");
    setMemoryRequest("");
    setCpuLimit("");
    setMemoryLimit("");
    setErrorMessage("");
    setFormVersion((version) => version + 1);
  }, []);

  const handleClose = useCallback(() => {
    if (isProvisioning) return;
    clear();
    onClose();
  }, [clear, isProvisioning, onClose]);

  const handleCancel = useCallback(() => {
    if (isProvisioning) return;
    clear();
    (onCancel ?? onClose)();
  }, [clear, isProvisioning, onCancel, onClose]);

  const handleProvision = useCallback(() => {
    if (isProvisioning) return;
    const task = taskName.trim();
    const kubeContext = context.trim();
    if (!task || !kubeContext) {
      setErrorMessage(t("pairing.agentExecutor.errors.required"));
      return;
    }

    const parsedEgressHosts = egressHosts
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
    if (parsedEgressHosts.length === 0) {
      setErrorMessage(t("pairing.agentExecutor.errors.egressRequired"));
      return;
    }

    setIsProvisioning(true);
    setErrorMessage("");
    void provisionAxHost({
      taskName: task,
      label: task,
      kubeContext,
      namespace: namespace.trim() || DEFAULT_AX_NAMESPACE,
      atespace: atespace.trim() || DEFAULT_AX_ATESPACE,
      image: image.trim() || DEFAULT_AX_IMAGE,
      egressHosts: parsedEgressHosts,
      ...(repo.trim() ? { repo: repo.trim() } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(cpuRequest.trim() ? { cpuRequest: cpuRequest.trim() } : {}),
      ...(memoryRequest.trim() ? { memoryRequest: memoryRequest.trim() } : {}),
      ...(cpuLimit.trim() ? { cpuLimit: cpuLimit.trim() } : {}),
      ...(memoryLimit.trim() ? { memoryLimit: memoryLimit.trim() } : {}),
    })
      .then((profile) => {
        onSaved?.({ profile, serverId: profile.serverId });
        clear();
        onClose();
        return undefined;
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsProvisioning(false));
  }, [
    atespace,
    branch,
    clear,
    context,
    cpuLimit,
    cpuRequest,
    egressHosts,
    image,
    isProvisioning,
    memoryLimit,
    memoryRequest,
    namespace,
    onClose,
    onSaved,
    provisionAxHost,
    repo,
    t,
    taskName,
  ]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      desktopMaxWidth={640}
      testID="add-ax-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.agentExecutor.helper")}</Text>

      <AxTextField
        label={t("pairing.agentExecutor.fields.task")}
        value={taskName}
        onChangeText={setTaskName}
        placeholder="paseo-dev"
        disabled={isProvisioning}
        resetKey={formVersion}
        testID="ax-task-input"
      />
      <AxTextField
        label={t("pairing.agentExecutor.fields.context")}
        value={context}
        onChangeText={setContext}
        placeholder="my-kubernetes-context"
        disabled={isProvisioning}
        resetKey={formVersion}
        testID="ax-context-input"
      />

      <View style={styles.row}>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.namespace")}
            value={namespace}
            onChangeText={setNamespace}
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.atespace")}
            value={atespace}
            onChangeText={setAtespace}
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
      </View>

      <AxTextField
        label={t("pairing.agentExecutor.fields.repo")}
        value={repo}
        onChangeText={setRepo}
        placeholder="https://github.com/org/repo.git"
        disabled={isProvisioning}
        resetKey={formVersion}
      />
      <AxTextField
        label={t("pairing.agentExecutor.fields.branch")}
        value={branch}
        onChangeText={setBranch}
        placeholder="main"
        disabled={isProvisioning}
        resetKey={formVersion}
      />
      <AxTextField
        label={t("pairing.agentExecutor.fields.image")}
        value={image}
        onChangeText={setImage}
        disabled={isProvisioning}
        resetKey={formVersion}
      />
      <AxTextField
        label={t("pairing.agentExecutor.fields.egress")}
        value={egressHosts}
        onChangeText={setEgressHosts}
        disabled={isProvisioning}
        resetKey={formVersion}
      />

      <View style={styles.row}>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.cpuRequest")}
            value={cpuRequest}
            onChangeText={setCpuRequest}
            placeholder="500m"
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.cpuLimit")}
            value={cpuLimit}
            onChangeText={setCpuLimit}
            placeholder="2"
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.memoryRequest")}
            value={memoryRequest}
            onChangeText={setMemoryRequest}
            placeholder="1Gi"
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
        <View style={styles.grow}>
          <AxTextField
            label={t("pairing.agentExecutor.fields.memoryLimit")}
            value={memoryLimit}
            onChangeText={setMemoryLimit}
            placeholder="4Gi"
            disabled={isProvisioning}
            resetKey={formVersion}
          />
        </View>
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.actions}>
        <Button
          variant="secondary"
          style={FLEX_ONE_STYLE}
          onPress={handleCancel}
          disabled={isProvisioning}
        >
          {t("pairing.agentExecutor.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleProvision}
          disabled={isProvisioning}
          testID="ax-provision-submit"
        >
          {isProvisioning
            ? t("pairing.agentExecutor.actions.provisioning")
            : t("pairing.agentExecutor.actions.provision")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

interface AxTextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  disabled: boolean;
  resetKey: number;
  testID?: string;
}

function AxTextField({
  label,
  value,
  onChangeText,
  placeholder,
  disabled,
  resetKey,
  testID,
}: AxTextFieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <AdaptiveTextInput
        initialValue={value}
        resetKey={resetKey}
        onChangeText={onChangeText}
        placeholder={placeholder}
        style={styles.input}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        testID={testID}
      />
    </View>
  );
}
