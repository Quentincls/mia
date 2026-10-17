# Skills pour agents IA (Claude, Codex)

Trois fiches au format **SKILL.md** (en-tête `name` + `description`, puis le mode d'emploi en français) qui
apprennent à un assistant à travailler avec Mia : la piloter, choisir une méthode, faire évoluer son code.

| Skill | Quand l'assistant s'en sert |
|---|---|
| `mia-piloter` | Piloter Mia par son serveur MCP (outils `mia_*`) : projets et planches, blocs, fils, réglages, aperçu puis rendu final, résultats, pièges. |
| `mia-recettes-video` | Choisir la méthode et les blocs d'un plan : LTX + LoRA, Rendre photoréaliste, Vidéo guidée, Références MiniMax, Animer un personnage, Finition et looks, Son, montage, passes. Les règles qui marchent (clé sur la 1re image, aperçu d'abord, pas de flou de mouvement, image de fin, pas de fondu enchaîné). |
| `mia-developper` | Modifier le code de Mia sans casser : architecture, carte du code, ajouter un bloc ou un outil MCP, règles, tests, instance cachée, ne jamais recharger la fenêtre de l'utilisateur. |

Elles décrivent le code **actuel** : noms d'outils de `mcp/mia-mcp.js`, blocs et réglages de
`src/catalog/nodes.json`. Après un changement de catalogue ou d'outil MCP, relire la fiche concernée.

## Installer

Chaque dossier se copie tel quel :

- Claude Code : `%USERPROFILE%\.claude\skills\<nom>\SKILL.md`
- Codex : `%USERPROFILE%\.codex\skills\<nom>\SKILL.md`

Dans l'invite de commandes (`cmd`), depuis le dossier de Mia (le dossier `resources\app` pour une Mia installée) :

```
for %s in (mia-piloter mia-recettes-video mia-developper) do (
  xcopy /y /i "skills\%s" "%USERPROFILE%\.claude\skills\%s"
  xcopy /y /i "skills\%s" "%USERPROFILE%\.codex\skills\%s"
)
```

Relancer l'assistant ensuite. Une copie installée peut être adaptée à ta façon de travailler (tes LoRA, tes
looks, tes règles) : c'est elle que lit l'assistant, pas celle du dépôt.

Pour piloter Mia, l'assistant doit aussi connaître son serveur MCP : voir `mcp/README.md`.
