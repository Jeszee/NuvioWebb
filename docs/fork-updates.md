# Updates van upstream binnenhalen

Deze fork (`origin`) volgt de originele ontwikkelaar (`upstream` = `alphasquare404/NuvioWeb`).

- `web`: zuivere kopie van upstream, hier werk je niet in.
- `mijn-werk-op-web`: upstream plus eigen functionaliteit (TVDB, MDBList-lijstbeheer, Simkl device-flow, tracking-kaarten, fixes).

## Routine

```powershell
git fetch upstream

# 1. Houd `web` gelijk aan upstream
git checkout web
git merge --ff-only upstream/web
git push origin web

# 2. Haal de wijzigingen in je eigen versie
git checkout mijn-werk-op-web
git merge web
```

Los eventuele conflicten op, daarna:

```powershell
npm test
git push origin mijn-werk-op-web
```

## Conflicten

- Bij overlap wint meestal upstream; zet alleen echt eigen functionaliteit er weer overheen.
- Veelvoorkomende conflictplekken: `js/ui/screens/settings/settingsScreen.js`, `js/ui/screens/trakt/traktScreen.js`, `css/desktop.css`, `res/values*/strings.xml`.
- Bewaar bij tracking-kaarten de eigen kaartopmaak (`renderTrackingProviderCard`, `settings-provider-*` in `css/desktop.css`) en de Simkl device-flow (`startDeviceAuth`/`cancelDeviceAuth`).

## Testen in Docker

```powershell
docker compose -p nuvioweb-test -f docker-compose.yml -f docker-compose.test.yml up -d --build nuvioweb
```

Daarna draait de testversie op <http://localhost:4174>. Er is een `.env` nodig (zie `.env.example`); de client-ID's daarin staan bewust leeg.

## Let op

- Sla nooit client-ID's of API-sleutels op in de repo; alleen in `.env`.
- Is `web` niet fast-forward te mergen, dan is er in de fork rechtstreeks op `web` gewerkt; zet die wijzigingen dan eerst over naar `mijn-werk-op-web`.
