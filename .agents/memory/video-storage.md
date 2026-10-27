---
name: Direct video storage
description: Decision and constraint for locally uploaded anime videos
---

Les vidéos importées par les formulaires Studio sont conservées dans IndexedDB sous forme de Blob, tandis que les données catalogue ne gardent qu’un identifiant de vidéo. Un service worker les envoie ensuite par morceaux vers l’API d’upload et reprend les envois en attente via Background Sync. Les formulaires d’administration restent basés sur les liens de lecteurs externes.

**Why:** Les épisodes vidéo du Studio dépassent rapidement les limites pratiques de localStorage et doivent rester lisibles avec un lecteur HTML5 natif. L’administration conserve volontairement son flux historique de lecteurs externes, tandis qu’une file persistante est nécessaire pour ne pas perdre un upload Studio lors d’une navigation ou d’une fermeture de page.

**How to apply:** Les nouvelles fonctions Studio qui importent une vidéo doivent réutiliser IndexedDB, enregistrer uniquement une référence sérialisable dans les données catalogue et déclencher la file d’upload en arrière-plan. Les fonctions d’administration doivent conserver le format de lecteurs externes.