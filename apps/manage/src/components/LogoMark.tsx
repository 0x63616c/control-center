/** The coloured letter chip that stands in for a tool's logo. */
export function LogoMark({
  color,
  mark,
  className = "logo",
}: {
  color: string;
  mark: string;
  className?: string;
}) {
  return (
    <div className={className} style={{ background: color }} aria-hidden="true">
      {mark}
    </div>
  );
}
