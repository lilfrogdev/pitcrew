import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown, IconSettings } from "@tabler/icons-react";
import type { ModelChoice, ModelSelection, ModelSettings } from "@pitcrew/protocol";
import styles from "./ModelPicker.module.css";

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
          <select
            aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={!model || undefined}
            value={model ? selection.modelId : ""}
            disabled={disabled || !models.some((choice) => choice.efforts.length)}
            onChange={(event) => {
              const choice = models.find((item) => item.id === event.target.value);
              const effort = choice && preferredEffort(choice);
              if (choice && effort) onSelection({ modelId: choice.id, effort });
            }}
          >
            {!model && (
              <option value="" disabled>
                Model unavailable
              </option>
            )}
            {models.map((choice) => (
              <option key={choice.id} value={choice.id} disabled={!choice.efforts.length}>
                {choice.label} · {choice.provider}
              </option>
            ))}
          </select>
          <IconChevronDown size={14} stroke={1.5} aria-hidden="true" />
        </label>
        <label className={styles.control}>
          <span className={styles.srOnly}>{label} effort</span>
          <select
            aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={(!!model && !!error) || undefined}
            value={model?.efforts.includes(selection.effort) ? selection.effort : ""}
            disabled={disabled || !model?.efforts.length}
            onChange={(event) => {
              const effort = model?.efforts.find((item) => item === event.target.value);
              if (effort) onSelection({ ...selection, effort });
            }}
          >
            {(!model || !model.efforts.includes(selection.effort)) && (
              <option value="" disabled>
                Effort unavailable
              </option>
            )}
            {model?.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort === "off" ? "Off" : effort.charAt(0).toUpperCase() + effort.slice(1)} effort
              </option>
            ))}
          </select>
          <IconChevronDown size={14} stroke={1.5} aria-hidden="true" />
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
                <select
                  value={override ? "override" : "inherit"}
                  disabled={disabled || saving}
                  onChange={(event) => {
                    const roles = { ...draft.roles };
                    if (event.target.value === "inherit") delete roles[role];
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
                >
                  <option value="inherit">Inherit repo agent model and effort</option>
                  <option value="override" disabled={!models.some((model) => model.efforts.length)}>
                    Use role override
                  </option>
                </select>
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
