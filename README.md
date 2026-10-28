# MozAnim

Catalogue francophone d’animés, films, scans et webtoons, avec fiches de lecture, comptes et API à clés.

## Développement

- `npm run dev` lance l’aperçu Vite sur le port 5000.
- `npm run build` compile le site.
- `npm start` sert la version compilée et ses routes API.

La base PostgreSQL Replit stocke les comptes, sessions, clés API et œuvres importées. Le schéma de développement est documenté dans `server/schema.sql`. Les mots de passe et les clés API ne sont pas enregistrés en clair.

Les fiches et lecteurs sont récupérés depuis Anime-Sama. Chaque clé API peut être limitée à des types de contenu et à la lecture seule ou à l’écriture.
