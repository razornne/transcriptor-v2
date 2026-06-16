"use client";
import { useState } from "react";
import type { Copy } from "@/lib/content";

export function FAQ({ t }: { t: Copy }) {
  const [open, setOpen] = useState<number | null>(null);
  const toggle = (i: number) => setOpen(open === i ? null : i);

  return (
    <section className="faq" id="faq">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.faq.eyebrow}</span>
          <h2 className="display xl">{t.faq.title}</h2>
        </div>
        <div className="faq-list reveal">
          {t.faq.items.map((item, i) => (
            <div key={i} className={"faq-item" + (open === i ? " open" : "")}>
              <button
                className="faq-q"
                onClick={() => toggle(i)}
                aria-expanded={open === i}
              >
                <span>{item.q}</span>
                <span className="faq-icon" aria-hidden="true">+</span>
              </button>
              <div className="faq-body">
                <div className="faq-a-inner"><p>{item.a}</p></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
