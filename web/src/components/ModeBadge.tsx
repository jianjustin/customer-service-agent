import type { BootstrapModel } from "../types";

export function ModeBadge({ model }: { model: BootstrapModel | null }) {
  if (!model) return <span className="mode-badge mode-unknown">模型状态未知</span>;
  if (model.mode === "mock") {
    return (
      <span className="mode-badge mode-mock" title={model.reason}>
        Mock 模式
      </span>
    );
  }
  return (
    <span className="mode-badge mode-real" title={model.modelName ?? model.reason}>
      {model.label}
    </span>
  );
}
