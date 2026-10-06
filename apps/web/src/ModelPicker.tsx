import { useEffect, useId, useRef, useState } from "react";
import { IconBrandOpenai, IconCpu, IconSettings } from "@tabler/icons-react";
import type { ModelChoice, ModelSelection, ModelSettings } from "@pitcrew/protocol";
import styles from "./ModelPicker.module.css";
import { Select } from "./Select";
import openRouterLogo from "./assets/openrouter.svg";

export interface ModelPickerProps {
  models: ModelChoice[];
  selection: ModelSelection;
  onSelection: (selection: ModelSelection) => void;
  disabled: boolean;
  label?: string;
}

function preferredEffort(model: ModelChoice): ModelSelection["effort"] | undefined {
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort))
    return model.defaultEffort;
  return model.efforts.includes("medium") ? "medium" : model.efforts[0];
}

function selectionError(models: ModelChoice[], selection: ModelSelection): string | undefined {
  const model = models.find((choice) => choice.id === selection.modelId);
  if (!model) return "Selected model is unavailable. Choose an available model before sending.";
  if (!model.efforts.includes(selection.effort)) {
    return "Selected effort is unavailable for this model. Choose a supported effort before sending.";
  }
  return undefined;
}

/** Controlled thread preference. The server freezes this preference only on new admission. */
export function ModelPicker({
  models,
  selection,
  onSelection,
  disabled,
  label = "Repo agent",
}: ModelPickerProps) {
  const id = useId();
  const model = models.find((choice) => choice.id === selection.modelId);
  const error = selectionError(models, selection);
  return (
    <div className={styles.picker}>
      <div className={styles.controls} role="group" aria-label={`${label} model and effort`}>
        <label className={styles.control}>
          <span className={styles.srOnly}>{label} model</span>
          <span
            className={styles.provider}
            role="img"
            aria-label={`${model?.provider ?? "Unknown"} provider`}
          >
            {model?.provider === "openrouter" ? (
              <img src={openRouterLogo} alt="" />
            ) : model?.provider === "openai" ? (
              <IconBrandOpenai size={18} stroke={1.5} aria-hidden="true" />
            ) : (
              <IconCpu size={18} stroke={1.5} aria-hidden="true" />
            )}
          </span>
          <Select
            label={`${label} model`}
            describedBy={error ? `${id}-error` : undefined}
            invalid={!model}
            value={model ? selection.modelId : ""}
            disabled={disabled}
            placeholder="Model unavailable"
            compact
            options={models.map((choice) => ({
              value: choice.id,
              label: choice.label,
              disabled: !choice.efforts.length,
            }))}
            onChange={(value) => {
              const choice = models.find((item) => item.id === value);
              const effort = choice && preferredEffort(choice);
              if (choice && effort) onSelection({ modelId: choice.id, effort });
            }}
          />
        </label>
        <label className={styles.control}>
          <span className={styles.srOnly}>{label} effort</span>
          <Select
            label={`${label} effort`}
            describedBy={error ? `${id}-error` : undefined}
            invalid={!!model && !!error}
            value={model?.efforts.includes(selection.effort) ? selection.effort : ""}
            disabled={disabled}
            placeholder="Effort unavailable"
            compact
            options={(model?.efforts ?? []).map((effort) => ({
              value: effort,
              label: effort === "off" ? "Off" : effort.charAt(0).toUpperCase() + effort.slice(1),
            }))}
            onChange={(value) => {
              const effort = model?.efforts.find((item) => item === value);
              if (effort) onSelection({ ...selection, effort });
            }}
          />
        </label>
      </div>
      {error && (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface WorkerModelSettingsProps {
  models: ModelChoice[];
  settings: ModelSettings;
  onSave: (settings: ModelSettings) => Promise<unknown>;
  disabled: boolean;
}

export function WorkerModelSettings({
  models,
  settings,
  onSave,
  disabled,
}: WorkerModelSettingsProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setDraft(settings);
    setSaved(false);
    setError(undefined);
  }, [settings]);
  const valid =
    !selectionError(models, draft.default) &&
    Object.values(draft.roles ?? {}).every((selection) => !selectionError(models, selection));
  const update = (next: ModelSettings) => {
    setDraft(next);
    setSaved(false);
    setError(undefined);
  };
  return (
    <details className={styles.settings}>
      <summary>
        <IconSettings size={16} stroke={1.5} aria-hidden="true" /> Repository model defaults
      </summary>
      <div className={styles.settingsBody}>
        <p>
          New conversations start with this repo agent default. Changes apply to new submissions and
          runs; active workers keep their models.
        </p>
        <ModelPicker
          models={models}
          selection={draft.default}
          disabled={disabled || saving}
          onSelection={(selection) => update({ ...draft, default: selection })}
          label="Repository default"
        />
        {(["implementer", "reviewer"] as const).map((role) => {
          const override = draft.roles?.[role];
          const name = role === "implementer" ? "Implementer" : "Reviewer";
          return (
            <div className={styles.role} key={role}>
              <label className={styles.roleLabel}>
                {name} model source
                <Select
                  label={`${name} model source`}
                  value={override ? "override" : "inherit"}
                  disabled={disabled || saving}
                  options={[
                    { value: "inherit", label: "Inherit repo agent model and effort" },
                    {
                      value: "override",
                      label: "Use role override",
                      disabled: !models.some((model) => model.efforts.length),
                    },
                  ]}
                  onChange={(value) => {
                    const roles = { ...draft.roles };
                    if (value === "inherit") delete roles[role];
                    else {
                      const choice =
                        models.find(
                          (model) => model.id === draft.default.modelId && model.efforts.length,
                        ) ?? models.find((model) => model.efforts.length);
                      const effort = choice && preferredEffort(choice);
                      if (!choice || !effort) return;
                      roles[role] = { modelId: choice.id, effort };
                    }
                    update({ ...draft, roles });
                  }}
                />
              </label>
              {override && (
                <ModelPicker
                  models={models}
                  selection={override}
                  disabled={disabled || saving}
                  label={name}
                  onSelection={(selection) =>
                    update({ ...draft, roles: { ...draft.roles, [role]: selection } })
                  }
                />
              )}
            </div>
          );
        })}
        <p>Researcher overrides are unavailable because this runtime has no researcher executor.</p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {saved && <p role="status">Repository model defaults saved.</p>}
        <button
          type="button"
          disabled={disabled || saving || !valid}
          onClick={async () => {
            if (inFlight.current || disabled || !valid) return;
            inFlight.current = true;
            setSaving(true);
            setError(undefined);
            setSaved(false);
            try {
              await onSave(draft);
              setSaved(true);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not save repository model defaults.",
              );
            } finally {
              inFlight.current = false;
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save repository model defaults"}
        </button>
      </div>
    </details>
  );
}
