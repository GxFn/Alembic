/**
 * 混合通知：页面可见用 toast，不可见用 macOS 右上角系统通知
 *
 * 增强版：支持 title + body 双行展示、自定义图标、进度条动画
 * 使用 React JSX 渲染 toast（兼容 React 19）
 */
import React from 'react';
import toast from 'react-hot-toast';

const APP_TITLE = 'AutoSnippet';

/* ── macOS 系统通知（页面不可见时降级） ─────────────── */

function showSystemNotification(body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  const send = () => {
    try {
      new Notification(APP_TITLE, { body, tag: 'autosnippet' });
    } catch (_) {}
  };

  if (Notification.permission === 'granted') {
    send();
    return;
  }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') send();
    });
  }
}

/* ── 类型 ─────────────────────────────────────── */

export interface NotifyOptions {
  /** 通知类型 */
  type?: 'success' | 'error' | 'info';
  /** 可选标题（加粗显示在第一行） */
  title?: string;
  /** 停留时长 ms，默认 success=5000 error=8000 info=5000 */
  duration?: number;
}

/* ── 持续时间 ──────────────────────────────────── */

const DEFAULT_DURATIONS: Record<string, number> = {
  success: 5000,
  error: 8000,
  info: 5000,
};

/* ── 颜色 scheme ──────────────────────────────── */

const COLOR_SCHEMES: Record<string, { bg: string; border: string; bar: string; darkBg: string; darkBorder: string }> = {
  success: {
    bg: 'linear-gradient(135deg,#ecfdf5 0%,#f0fdf4 100%)',
    border: '#10b981',
    bar: '#10b981',
    darkBg: 'linear-gradient(135deg,#0c1a14 0%,#0f1f18 100%)',
    darkBorder: '#059669',
  },
  error: {
    bg: 'linear-gradient(135deg,#fef2f2 0%,#fff1f2 100%)',
    border: '#ef4444',
    bar: '#ef4444',
    darkBg: 'linear-gradient(135deg,#1c0f0f 0%,#1f1012 100%)',
    darkBorder: '#dc2626',
  },
  info: {
    bg: 'linear-gradient(135deg,#eff6ff 0%,#f0f9ff 100%)',
    border: '#3b82f6',
    bar: '#3b82f6',
    darkBg: 'linear-gradient(135deg,#0f1524 0%,#101828 100%)',
    darkBorder: '#2563eb',
  },
};

/* ── 图标组件 ─────────────────────────────────── */

const SuccessIcon = () => (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-emerald-500 shrink-0">
    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
  </svg>
);

const ErrorIcon = () => (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-red-400 shrink-0">
    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
  </svg>
);

const InfoIcon = () => (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-blue-400 shrink-0">
    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
  </svg>
);

const ICON_MAP: Record<string, React.FC> = {
  success: SuccessIcon,
  error: ErrorIcon,
  info: InfoIcon,
};

/* ── Toast 内容组件 ───────────────────────────── */

const ToastContent: React.FC<{
  visible: boolean;
  toastId: string;
  body: string;
  type: string;
  title?: string;
  duration: number;
}> = ({ visible, toastId, body, type, title, duration }) => {
  const scheme = COLOR_SCHEMES[type] || COLOR_SCHEMES.info;
  const IconComp = ICON_MAP[type] || InfoIcon;
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div
      onClick={() => toast.dismiss(toastId)}
      style={{
        background: dark ? scheme.darkBg : scheme.bg,
        borderLeft: `4px solid ${dark ? scheme.darkBorder : scheme.border}`,
        borderRadius: 10,
        boxShadow: dark
          ? '0 8px 30px rgba(0,0,0,.4),0 2px 8px rgba(0,0,0,.25)'
          : '0 8px 30px rgba(0,0,0,.12),0 2px 8px rgba(0,0,0,.06)',
        padding: '12px 16px 10px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        minWidth: 280,
        maxWidth: 420,
        position: 'relative' as const,
        overflow: 'hidden' as const,
        cursor: 'pointer',
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : -8}px)`,
        transition: 'opacity .25s ease, transform .25s ease',
      }}
    >
      {/* 图标 */}
      <div style={{ marginTop: 1 }}>
        <IconComp />
      </div>

      {/* 文本 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3, color: dark ? '#e2e8f0' : '#1e293b', marginBottom: 2 }}>
            {title}
          </div>
        )}
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: dark ? '#94a3b8' : '#475569', wordBreak: 'break-word' as const }}>
          {body}
        </div>
      </div>

      {/* 底部进度条 */}
      <div
        style={{
          position: 'absolute' as const,
          bottom: 0,
          left: 0,
          height: 3,
          width: '100%',
          background: scheme.bar,
          opacity: 0.45,
          animation: `toast-progress ${duration}ms linear forwards`,
        }}
      />
    </div>
  );
};

/* ── 核心 ─────────────────────────────────────── */

/**
 * 发送一条 Toast 通知。
 *
 * @param body  - 通知正文
 * @param options - 可选配置：type / title / duration
 *
 * @example
 *   notify('操作成功');
 *   notify('提取完成，已加入候选池', { title: '提取', type: 'success' });
 *   notify('网络超时', { title: '请求失败', type: 'error' });
 */
export function notify(body: string, options?: NotifyOptions) {
  const type = options?.type ?? 'success';
  const title = options?.title;
  const duration = options?.duration ?? DEFAULT_DURATIONS[type] ?? 5000;

  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    showCustomToast(body, type, title, duration);
  } else {
    showSystemNotification(title ? `${title}: ${body}` : body);
  }
}

/* ── 自定义 Toast 渲染 ──────────────────────────── */

function showCustomToast(
  body: string,
  type: string,
  title: string | undefined,
  duration: number,
) {
  toast.custom(
    (t) => (
      <ToastContent
        visible={t.visible}
        toastId={t.id}
        body={body}
        type={type}
        title={title}
        duration={duration}
      />
    ),
    { duration },
  );
}

/* ── 进度条动画样式（首次注入） ─────────────────── */

if (typeof document !== 'undefined') {
  const STYLE_ID = 'asd-toast-progress-style';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
@keyframes toast-progress {
  from { width: 100%; }
  to   { width: 0%; }
}`;
    document.head.appendChild(style);
  }
}
