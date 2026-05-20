"use client";
import { useEffect, useState } from "react";
import { COPY, DEFAULT_HEADLINE, HEADLINES, type Lang } from "@/lib/content";
import { useReveal } from "@/lib/hooks";
import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { Social } from "./Social";
import { HowItWorks } from "./HowItWorks";
import { Features } from "./Features";
import { Breakout } from "./Breakout";
import { Pricing } from "./Pricing";
import { FinalCTA } from "./FinalCTA";
import { Footer } from "./Footer";

export function LandingClient() {
  const [lang, setLang] = useState<Lang>("en");

  // Sync `data-lang` на <html> для CSS-свапа шрифтов (UA→Unbounded).
  useEffect(() => {
    const saved = (localStorage.getItem("skriptly-lang") as Lang | null) || "en";
    setLang(saved);
    document.documentElement.setAttribute("data-lang", saved);
    document.documentElement.lang = saved === "ua" ? "uk" : "en";
  }, []);

  const changeLang = (v: Lang) => {
    setLang(v);
    document.documentElement.setAttribute("data-lang", v);
    document.documentElement.lang = v === "ua" ? "uk" : "en";
    try { localStorage.setItem("skriptly-lang", v); } catch {}
  };

  useReveal();

  const t = COPY[lang];
  const headlineLines = HEADLINES[lang][DEFAULT_HEADLINE];

  return (
    <>
      <Nav t={t} lang={lang} setLang={changeLang} />
      <Hero t={t} headlineLines={headlineLines} />
      <Social t={t} />
      <HowItWorks t={t} />
      <Features t={t} />
      <Breakout t={t} />
      <Pricing t={t} />
      <FinalCTA t={t} />
      <Footer t={t} lang={lang} setLang={changeLang} />
    </>
  );
}
