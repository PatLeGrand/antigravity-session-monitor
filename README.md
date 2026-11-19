# Session Monitor

Panneau latéral live pour Antigravity qui affiche, pour la conversation courante :

- **Contexte** : tokens du dernier appel modèle (`input_tokens + cache_read_tokens`), % d'une limite
  choisie (128k → 2M, mémorisée), pic, courbe d'évolution (les chutes = compactions).
- **Sous-agents** : arbre des sous-agents lancés (`invoke_subagent`), état live
  (en cours / terminé / erreur / bloqué / arrêté), étapes, outils, contexte, activité courante.
  Clic = ouvrir la conversation du sous-agent.
- **Outils** : totaux par outil (avec erreurs) et liste des derniers appels.

Les données sont lues en lecture seule depuis
`~/.gemini/<app>/brain/<conversation>/.system_generated/logs/transcript.jsonl` (rafraîchi toutes les 2 s).

## Structure

```
plugin.json
skills/session-monitor/SKILL.md   # permet à l'agent d'ouvrir le panneau sur demande
sidecars/monitor/                 # backend Node (sidecar_sdk) + UI
```
