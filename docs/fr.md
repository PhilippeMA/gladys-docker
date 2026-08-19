# Docker

Gérez les conteneurs Docker de votre serveur depuis Gladys : voyez s'ils
tournent, démarrez-les et arrêtez-les depuis un tableau de bord ou une scène,
redémarrez-les depuis l'écran de configuration, et suivez leur consommation
CPU et mémoire.

## Comment l'intégration joint Docker

Gladys exécute chaque intégration externe dans un conteneur isolé qui **ne peut
monter aucun chemin de votre hôte**, et `/var/run/docker.sock` est un chemin de
l'hôte. Cette intégration n'utilise donc pas la socket Docker : elle dialogue
avec l'**API Docker Engine par le réseau**, à une adresse que vous fournissez.

Vous avez deux façons d'exposer cette API. La première est fortement
recommandée.

### Option A — un proxy de socket (recommandé)

Un proxy de socket se place devant la socket Docker et ne relaie que les appels
que vous autorisez. Même si quelqu'un d'autre sur votre réseau l'atteignait, il
ne pourrait pas créer un conteneur privilégié sur votre hôte.

Ajoutez ceci à un `docker-compose.yml` sur la machine qui fait tourner vos
conteneurs :

```yaml
services:
  docker-proxy:
    image: ghcr.io/tecnativa/docker-socket-proxy:0.3.0
    restart: unless-stopped
    ports:
      - '2375:2375'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      CONTAINERS: 1 # lister les conteneurs (obligatoire)
      POST: 1 # autoriser démarrage / arrêt / redémarrage
```

Puis `docker compose up -d`, et utilisez `http://<ip-de-cette-machine>:2375`
comme adresse ci-dessous.

Deux remarques sur ces permissions :

- `CONTAINERS: 1` seul donne une intégration **en lecture seule** : les états,
  le CPU et la mémoire fonctionnent, l'interrupteur On/Off et le bouton de
  redémarrage non.
- `POST: 1` est ce qui autorise le démarrage, l'arrêt et le redémarrage. Il est
  limité aux points d'entrée exposés par le proxy : il ne permet pas de créer
  des conteneurs.

Le proxy n'a pas d'authentification propre : publiez son port sur un réseau de
confiance, jamais sur Internet.

### Option B — le daemon Docker lui-même

Si votre daemon écoute déjà en TCP (`-H tcp://0.0.0.0:2375`, ou une entrée
`hosts` dans `/etc/docker/daemon.json`), pointez l'intégration directement
dessus. Attention : une API Docker non protégée donne un accès **équivalent à
root** sur cette machine. Ne le faites que sur un réseau de confiance, et
préférez l'option A.

Les adresses `https://` sont supportées. Les certificats client (`--tlsverify`
avec une paire de clés client) ne le sont pas : si votre daemon les exige,
placez plutôt un proxy de socket devant lui.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. **Adresse de l'API Docker** — par exemple `http://192.168.1.10:2375`. La
   forme `tcp://hote:port` utilisée par le CLI Docker et un simple `hote:port`
   sont également acceptés.
3. Cliquez sur **Tester la connexion Docker**. La réponse indique la version de
   Docker et le nombre de conteneurs correspondant à vos filtres. Corrigez ce
   point avant d'aller plus loin : rien d'autre ne fonctionne tant qu'il échoue.
4. **Conteneurs à inclure / à exclure** — des noms séparés par des virgules où
   `*` remplace n'importe quoi, par exemple `media-*, nginx`. Laisser la liste
   d'inclusion vide expose tous les conteneurs. La liste d'exclusion est
   appliquée en dernier et vaut `gladys*` par défaut : les conteneurs qui font
   tourner Gladys lui-même restent hors de portée — les piloter depuis Gladys
   reviendrait à pouvoir arrêter ce qui tient l'interrupteur.
5. Cliquez sur **Lister les conteneurs correspondants** pour vérifier vos
   filtres avant d'enregistrer.
6. Enregistrez : les conteneurs apparaissent dans l'onglet **Découverte**,
   prêts à être ajoutés.

Les autres réglages :

| Réglage                         | Ce qu'il change                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposer les conteneurs arrêtés | Si les conteneurs actuellement arrêtés sont listés dans la Découverte.                                                                                                                            |
| Collecter CPU et mémoire        | Ajoute un capteur CPU et un capteur mémoire à chaque conteneur. Coûte environ une seconde de daemon par rafraîchissement.                                                                         |
| Intervalle de rafraîchissement  | Fréquence de mise à jour de l'état et des capteurs d'un conteneur. Gladys interroge un appareil au plus lentement une fois par minute : les choix vont de 10 secondes à 1 minute.                 |
| Intervalle de découverte        | Fréquence de relecture de la liste, pour que les conteneurs créés ensuite apparaissent d'eux-mêmes. C'est le minuteur propre à l'intégration, sans rapport avec l'intervalle de rafraîchissement. |
| Délai d'arrêt                   | Le temps laissé par Docker à un conteneur pour s'arrêter avant de le tuer.                                                                                                                        |

## À quoi ressemble un conteneur dans Gladys

| Fonctionnalité | Type         | Ce qu'elle fait                                               |
| -------------- | ------------ | ------------------------------------------------------------- |
| On/Off         | Interrupteur | Démarre et arrête le conteneur. Utilisable dans les scènes.   |
| État           | Texte        | `running`, `exited`, `restarting`, `paused`…                  |
| CPU            | Pourcentage  | Même échelle que `docker stats` : 200 % = deux cœurs saturés. |
| Mémoire        | Mégaoctets   | Mémoire de travail, cache de pages exclu.                     |

Les conteneurs créés par Docker Compose sont nommés `projet · service` ; les
autres gardent leur nom de conteneur. La page de l'appareil affiche aussi
l'image utilisée et, pour un conteneur Compose, son projet et son service.

Chaque appareil porte un badge **local**, qui passe à l'orange quand le
conteneur mérite un coup d'œil — redémarrages en boucle, en pause, mort, ou en
échec de son propre health check — et au gris quand le daemon n'est plus
joignable.

## Actions

- **Tester la connexion Docker** — contacte le daemon et affiche sa version, sa
  plateforme et le nombre de conteneurs sélectionnés par vos filtres.
- **Lister les conteneurs correspondants** — montre exactement ce que vos
  filtres d'inclusion et d'exclusion sélectionnent. Le moyen le plus rapide de
  comprendre pourquoi un conteneur apparaît ou non.
- **Redémarrer un conteneur** — choisissez un de vos conteneurs et
  redémarrez-le, sans avoir à construire une scène arrêt-puis-démarrage.

## Bon à savoir

- **Les conteneurs sont suivis par leur nom, pas par leur identifiant.** Un
  `docker compose up` après une mise à jour d'image recrée le conteneur avec un
  identifiant tout neuf mais le même nom : vos appareils, leur historique et
  les scènes qui les utilisent survivent à la mise à jour.
- **Renommer un conteneur crée un nouvel appareil.** Gladys voit l'ancien
  disparaître et un nouveau apparaître dans la Découverte.
- **Les conteneurs arrêtés restent pilotables.** Masquer les conteneurs arrêtés
  ne change que ce que propose la Découverte ; un appareil déjà ajouté garde son
  interrupteur et peut être redémarré.
- **L'état publié est celui du daemon, pas celui demandé.** Démarrez un
  conteneur qui plante au lancement et l'interrupteur revient sur off, parce que
  c'est ce que Docker rapporte.
- **Collecter CPU et mémoire n'est pas gratuit.** Docker met environ une seconde
  à répondre à une demande de statistiques, par conteneur. Avec vingt conteneurs
  rafraîchis toutes les 10 secondes, le daemon passe plus de temps à répondre
  qu'au repos : laissez l'intervalle sur une minute sauf si vous avez peu de
  conteneurs, ou désactivez les statistiques.

## En cas de problème

**« Impossible de joindre l'API Docker »** — l'adresse est fausse, le port n'est
pas publié, ou un pare-feu bloque la connexion. Depuis une autre machine du même
réseau, `curl http://<adresse>/version` doit répondre du JSON.

**« Docker API returned a non-JSON body »** — quelque chose a répondu, mais ce
n'était pas une API Docker : le plus souvent un serveur web ou la page d'un
routeur sur ce port.

**« Docker API 403 »** — un proxy de socket refuse l'appel. Ajoutez la
permission qui manque : `CONTAINERS: 1` pour lister, `POST: 1` pour démarrer,
arrêter et redémarrer.

**Aucun conteneur dans la Découverte** — cliquez sur **Lister les conteneurs
correspondants**. Une réponse vide signifie que vos filtres excluent tout ;
rappelez-vous que la liste d'exclusion vaut `gladys*` par défaut.

**Le CPU manque mais la mémoire est là** — il faut deux relevés consécutifs pour
calculer un pourcentage CPU. Le premier manque juste après un démarrage ; le
rafraîchissement suivant l'a.

L'intégration journalise tout ce qu'elle fait. Mettez `LOG_LEVEL=debug` pour
voir chaque appel à l'API Docker, puis lisez les logs de l'intégration depuis
l'interface de Gladys (ou `docker logs` sur l'hôte).
