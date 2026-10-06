import { useEffect, useState } from "react";
import { Icon } from "./icons";

export function Avatar({
  name,
  image,
  className,
  fallback = "initial",
}: {
  name?: string;
  image?: string | null;
  className: string;
  fallback?: "initial" | "icon";
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [image]);
  return (
    <span className={className} aria-hidden="true">
      {image && !broken ? (
        <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : fallback === "initial" && name ? (
        name.slice(0, 1).toUpperCase()
      ) : (
        <Icon kind="account" />
      )}
    </span>
  );
}
