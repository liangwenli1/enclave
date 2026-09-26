import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

/* 组件规格见 DESIGN.md。蓝色只给主操作（一屏一个）和"正在运行 / 已选中"。 */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-semibold whitespace-nowrap select-none transition-colors duration-150 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-fg hover:brightness-110 disabled:bg-accent-dim disabled:text-accent-fg disabled:hover:brightness-100",
        secondary:
          "bg-canvas text-ink border border-line-strong hover:bg-surface-2 hover:border-ink disabled:text-faint disabled:border-line disabled:hover:bg-canvas",
        ghost:
          "text-muted hover:bg-surface hover:text-ink disabled:text-faint disabled:hover:bg-transparent disabled:hover:text-faint",
        danger:
          "text-bad border border-bad/40 hover:bg-bad/10 disabled:text-faint disabled:hover:bg-transparent",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-5 text-sm",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

const fieldBase =
  "h-10 w-full rounded-md border border-line-strong bg-canvas px-3.5 text-sm text-ink placeholder:text-faint " +
  "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 " +
  "read-only:bg-surface-2 disabled:bg-surface-2 disabled:text-subtle";

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, className)} {...props}>
      {children}
    </select>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={cn(fieldBase, "min-h-20 py-2.5 leading-relaxed", className)} {...props} />
  );
}

/** 状态徽章。颜色只表示状态，永远配文字，不靠颜色单独传达信息。 */
export function Badge({
  className,
  tone = "neutral",
  children,
}: {
  className?: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
  children: ReactNode;
}) {
  const tones = {
    neutral: "text-subtle",
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {/* 出错是方点，其余是圆点：不只靠颜色区分。 */}
      <span className={cn("size-2 flex-none bg-current", tone === "bad" ? "" : "rounded-full")} />
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-[13px] text-bad">{error}</span> : null}
      {!error && hint ? <span className="text-[13px] text-subtle">{hint}</span> : null}
    </label>
  );
}

/** 页面标题 + 一行状态。每个页面顶部都用它，保持节奏一致。 */
export function PageHeader({
  title,
  status,
  actions,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[28px] leading-tight font-bold tracking-[-0.03em]">{title}</h1>
        {status ? <div className="mt-2 text-[13px] text-subtle">{status}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 空状态：一句说明 + 一个下一步。没有下一步的空页不允许存在。 */
export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-3 px-6 py-16 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <div className="text-base font-semibold text-ink">{title}</div>
      <p className="max-w-[46ch] text-[13px] text-subtle">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** 哈希 / 路径 / 原因码块，右上角常驻复制。工作台的招牌元素。 */
export function CodeBlock({
  label,
  value,
  className,
}: {
  label?: string;
  value: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <div className={cn("relative rounded-md bg-surface-2 p-4 pr-24", className)}>
      {label ? <div className="mb-1.5 text-[13px] text-subtle">{label}</div> : null}
      <code className="block font-mono text-[13px] leading-relaxed break-all text-muted">
        {value}
      </code>
      <button
        type="button"
        className={cn(
          "absolute top-3 right-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-canvas px-3 text-xs font-semibold transition-colors",
          done ? "text-ok" : "text-ink hover:border-ink",
        )}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          });
        }}
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {done ? "已复制" : "复制"}
      </button>
    </div>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  className,
  children,
  title,
}: {
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#070b14]/55" />
      <DialogPrimitive.Content
        className={cn(
          "enclave-dialog fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line p-6",
          className,
        )}
      >
        {title ? (
          <div className="mb-4 flex items-center justify-between gap-4">
            <DialogPrimitive.Title className="text-lg font-bold tracking-tight text-ink">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="关闭对话框"
              className="grid size-8 flex-none place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
        ) : (
          <DialogPrimitive.Title className="sr-only">Dialog</DialogPrimitive.Title>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Menu = DropdownMenuPrimitive.Root;
export const MenuTrigger = DropdownMenuPrimitive.Trigger;

export function MenuContent({
  children,
  align = "end",
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-44 rounded-lg border border-ink bg-canvas p-1 shadow-[0_12px_32px_rgb(0_0_0/0.18)]"
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-faint",
        danger ? "text-bad hover:bg-bad/10" : "text-muted hover:bg-surface-2 hover:text-ink",
      )}
    >
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-lg border border-line bg-canvas", className)}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-subtle">{hint}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const color = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-faint",
  }[tone];
  return (
    <span
      className={cn("inline-block size-2 flex-none", tone === "bad" ? "" : "rounded-full", color)}
    />
  );
}
