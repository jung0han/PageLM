import { useEffect, useState } from "react";
import {
  getSharedMaterials,
  getSharedNamespaces,
  getSourceBag,
  setSourceBag,
  type LearningMaterial,
  type SharedNamespaceSummary,
} from "../../lib/api";

type Props = { chatId: string };

export default function SharedSources({ chatId }: Props) {
  const [namespaces, setNamespaces] = useState<SharedNamespaceSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [materials, setMaterials] = useState<Record<string, LearningMaterial[]>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!chatId) return;
    Promise.all([getSharedNamespaces(), getSourceBag(chatId)])
      .then(([available, bag]) => {
        setNamespaces(available.namespaces || []);
        setSelected(bag.namespaceIds || []);
      })
      .catch(() => {
        setNamespaces([]);
        setSelected([]);
      });
  }, [chatId]);

  useEffect(() => {
    for (const namespaceId of selected) {
      if (materials[namespaceId]) continue;
      getSharedMaterials(namespaceId)
        .then(result => setMaterials(current => ({ ...current, [namespaceId]: result.materials || [] })))
        .catch(() => undefined);
    }
  }, [materials, selected]);

  const toggle = async (namespaceId: string) => {
    const next = selected.includes(namespaceId)
      ? selected.filter(id => id !== namespaceId)
      : [...selected, namespaceId];
    setSaving(true);
    try {
      const saved = await setSourceBag(chatId, next);
      setSelected(saved.namespaceIds);
    } finally {
      setSaving(false);
    }
  };

  if (!chatId || namespaces.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-zinc-900 bg-stone-950/80 p-4" aria-labelledby="shared-sources-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="shared-sources-title" className="font-semibold text-stone-100">공유 자료실</h2>
        <span className="text-xs text-stone-500">이 chat에서 사용할 자료를 선택하세요</span>
      </div>
      <div className="space-y-3">
        {namespaces.map(namespace => {
          const checked = selected.includes(namespace.id);
          return (
            <div key={namespace.id} className="rounded-xl border border-zinc-800 bg-black/30 px-4 py-3">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 accent-stone-200"
                  checked={checked}
                  disabled={saving}
                  onChange={() => void toggle(namespace.id)}
                />
                <span>
                  <span className="block text-sm font-medium text-stone-100">{namespace.title}</span>
                  {namespace.description && <span className="block text-xs text-stone-400">{namespace.description}</span>}
                </span>
              </label>
              {checked && (
                <div className="mt-3 border-t border-zinc-900 pt-3">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">학습 자료</h3>
                  {(materials[namespace.id] || []).map(material => (
                    <div key={material.id} className="mb-2 text-sm text-stone-300">
                      <div className="font-medium">{material.title}</div>
                      {material.description && <div className="text-xs text-stone-500">{material.description}</div>}
                      <div className="mt-1 text-xs text-stone-500">
                        {material.assets.map(asset => `${asset.filename} · ${asset.chunks.length} chunks`).join(", ")}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
