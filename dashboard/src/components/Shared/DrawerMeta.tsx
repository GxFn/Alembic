/**
 * DrawerMeta — 抽屉详情头部信息区域（Badges + Metadata + Tags）
 *
 * 统一三个抽屉（Candidates / Recipes / Knowledge）的头部元数据展示。
 * 调用方只需组装 badges / metadata / tags 数据，渲染完全统一。
 */
import React from 'react';
import { Tag, Hash, FolderOpen } from 'lucide-react';

/* ── 公共类型 ── */

/** 一个彩色标签徽章 */
export interface BadgeItem {
  /** 显示文字 */
  label: string;
  /** Tailwind className（bg / text / border 等） */
  className: string;
  /** 可选图标 */
  icon?: React.ElementType;
}

/** 一行 icon + label + value 的元数据项 */
export interface MetaItem {
  icon: React.ElementType;
  iconClass: string;
  label: string;
  value: string;
  /** 是否使用 mono 字体 */
  mono?: boolean;
  /** 是否占满整行 */
  fullWidth?: boolean;
  /** 是否使用 <code> 渲染 value */
  isCode?: boolean;
}

export interface DrawerMetaProps {
  /** 徽章列表（按顺序渲染） */
  badges: BadgeItem[];
  /** 元数据行 */
  metadata: MetaItem[];
  /** 标签（渲染为小型药丸） */
  tags?: string[];
  /** 最多显示多少个标签 */
  maxTags?: number;
  /** 可选：显示 ID 行 */
  id?: string;
  /** 可选：显示源文件行 */
  sourceFile?: string;
  /** 源文件行的标签文字（默认 "源文件"） */
  sourceFileLabel?: string;
}

/* ── 组件 ── */

const DrawerMeta: React.FC<DrawerMetaProps> = ({
  badges,
  metadata,
  tags,
  maxTags,
  id,
  sourceFile,
  sourceFileLabel = '源文件',
}) => {
  const displayTags = maxTags && tags ? tags.slice(0, maxTags) : tags;

  return (
    <>
      {/* 1. Badges + Metadata */}
      <div className="px-6 py-4 border-b border-[var(--border-default)] space-y-3">
        {/* Badge pills */}
        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {badges.map((b, i) => {
              const Icon = b.icon;
              return (
                <span key={i} className={`text-[10px] font-medium px-1.5 py-0.5 rounded border inline-flex items-center gap-1 ${b.className}`}>
                  {Icon && <Icon size={10} />}
                  {b.label}
                </span>
              );
            })}
          </div>
        )}

        {/* Metadata items */}
        {(metadata.length > 0 || id || sourceFile) && (
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
            {metadata.map((item, i) => {
              const Icon = item.icon;
              return (
                <div key={i} className={`flex items-center gap-1.5${item.fullWidth ? ' basis-full mt-0.5' : ''}`}>
                  <Icon size={11} className={`${item.iconClass} shrink-0`} />
                  <span className="text-[var(--fg-muted)]">{item.label}</span>
                  {item.isCode ? (
                    <code className="font-mono text-[11px] text-[var(--fg-secondary)] break-all">{item.value}</code>
                  ) : (
                    <span className={`font-medium text-[var(--fg-secondary)]${item.mono ? ' font-mono text-[11px]' : ''}`}>{item.value}</span>
                  )}
                </div>
              );
            })}
            {id && (
              <div className="flex items-center gap-1.5 basis-full mt-0.5">
                <Hash size={11} className="text-[var(--fg-muted)] shrink-0" />
                <span className="text-[var(--fg-muted)]">ID</span>
                <code className="font-mono text-[11px] text-[var(--fg-secondary)] break-all">{id}</code>
              </div>
            )}
            {sourceFile && (
              <div className="flex items-center gap-1.5 basis-full">
                <FolderOpen size={11} className="text-[var(--fg-muted)] shrink-0" />
                <span className="text-[var(--fg-muted)]">{sourceFileLabel}</span>
                <code className="font-mono text-[11px] text-[var(--fg-secondary)] break-all" title={sourceFile}>{sourceFile}</code>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. Tags */}
      {displayTags && displayTags.length > 0 && (
        <div className="px-6 py-3 border-b border-[var(--border-default)] flex flex-wrap items-center gap-1.5">
          <Tag size={11} className="text-[var(--fg-muted)] mr-0.5" />
          {displayTags.map((tag, i) => (
            <span key={i} className="text-[9px] px-2 py-0.5 rounded bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--border-default)] font-medium">
              {typeof tag === 'string' ? tag : String(tag)}
            </span>
          ))}
        </div>
      )}
    </>
  );
};

export default DrawerMeta;
