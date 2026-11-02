export interface IdentityOption {
  id: string;
  name: string;
}

export function IdentityPicker({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: IdentityOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const hasValue = options.some((o) => o.id === value);
  return (
    <label className="identity-picker">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {!hasValue && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
