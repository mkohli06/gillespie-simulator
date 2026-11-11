# Stochastic Reaction Simulator

A static web page (plain HTML + JavaScript, no build step, no dependencies) that lets a biologist write a
reaction model, simulate it with the Gillespie algorithm, run ensembles, and check the simulator against Tellurium.
All computation happens in the browser.

## Run it

Open `index.html` in a browser, or serve the folder (`python3 -m http.server`) and visit `localhost:8000`.

## Publish on GitHub Pages

1. Put all files in the root of a GitHub repository.
2. Settings → Pages → "Deploy from a branch" → `main` / root.
3. The site appears at `https://<user>.github.io/<repo>/`.

## Files

| File | What it is |
|---|---|
| `core.js` | UI-free core: parser, stoichiometry and propensities, seeded RNG, Gillespie direct method, gridding, ensembles, CSV, Antimony export, saved seeds, V1/V2/V3 maths |
| `plot.js` | Step-function canvas plot (shaded bands, zoom, PNG export) and a histogram |
| `app.js`, `index.html`, `style.css` | The interface |
| `test_core.js` | Unit tests: `node test_core.js` |
| `tellurium_ensemble.py` | Runs 500 Tellurium Gillespie runs for V2 |

## Model grammar

One statement per line; blank lines and comments (`#` or `//`) are ignored.

```
J1: A + B -> C; k1        reaction: name: reactants -> products; rate constant name
J2: 2 A -> ; k2           a blank side is allowed
J3: -> A; k3
A = 100                   species: whole number >= 0
k1 = 0.001                rate constant: number >= 0
```

* At most two reactant molecules per reaction (coefficients sum to 2 or less); coefficients are positive integers.
* `$S` marks a boundary species: used in the propensity, never changed.
* Every species and rate constant must have a value. Errors are reported with line number, the line, and a description.
* Reversible arrows are rejected (write two reactions). Reactions must have a name.
* Antimony import: the explicit mass-action form that Export writes (`J1: A + B -> C; k1*A*B`) is accepted as well as the bare constant name. Any other rate law is rejected.

## How it works (decisions worth knowing)

* **Propensity** a = c · ∏ C(Xᵢ, sᵢ): `c·X` for one molecule, `c·X(X−1)/2` for two of the same species, `c·X·Y` for two different species, `c` for none. Export writes `k*A*(A-1)/2` for 2A so that Tellurium uses the same propensity.
* **Gillespie**: r₁ = 1 − u lies in (0, 1], so it is never 0; τ = −ln(r₁)/a₀; r₂ picks the reaction. An event that would land after the end time is not applied. If a₀ = 0 the state stays fixed to the end.
* **Gridding**: a grid time takes the state after the last event at or before it, so an event exactly on a grid time is included. The grid always includes the end time.
* **Ensemble SD** is the sample SD (divides by N−1). Run *i* of an ensemble uses a seed derived from the master seed and *i*, so an ensemble is reproducible from one seed.
* **Single-run CSV** has one row per event plus a final row at the end time. **Ensemble CSV** has `time, <species>_mean, <species>_sd`.
* Single runs stop at 2,000,000 recorded events (the page says so); use an ensemble for very busy models.

## Validation tab

* **V1**: 1000 runs to the end time on the V1 panel; reports mean, variance, variance ÷ mean, histogram. PASS if variance ÷ mean is within 10% of 1 for every species whose mean is above 0 (species with mean 0 show n/a). Use the birth–death example for a model that should pass.
* **V2**: export the model, run `python tellurium_ensemble.py model.ant --end T --step DT --runs 500`, upload the CSV. The platform runs 500 runs on the file's time grid and compares. z = (m₁ − m₂)/√(SD₁²/n₁ + SD₂²/n₂). PASS needs ≤ 1% of |z| above 3, no species with average z beyond ±1 (drift), and ≤ 2% of SD comparisons (z using the standard error of an SD) above 3. The 1% / ±1 / 2% thresholds are our choices for "almost all" and "no consistent drift"; adjust in `compareEnsembles` if you want them tighter.
* **V3**: byte-for-byte CSV comparisons for same seed, different seed, a seed typed back in, and re-run from a saved seed, for single runs and ensembles. A model that fires no reactions fails the "different seeds differ" checks, because the seeds cannot be told apart.

## Status against the milestones

* M1, M2, M4, M5 (parser, single run, ensembles, Antimony export) and the V1/V3 logic are covered by `test_core.js`.
* M3 and the Validation tab UI are built; see the note below on what was and was not exercised in a real browser.
* **Not done and cannot be done by code:** M7 (usability testing with two non-computer-scientist volunteers, README screenshots), and a real V2 comparison, which needs Tellurium output. `tellurium_ensemble.py` has not been run against Tellurium; the V2 logic is tested only against our own simulator's CSV output. The first real V2 run may need small tweaks (for example Tellurium's gillespie output grid options).

## Suggested usability protocol (M7)

Give two volunteers these tasks with no help: (1) plot the default model; (2) change the end time and run again; (3) fix a deliberately broken model using the error messages; (4) run an ensemble and download the CSV; (5) repeat a run exactly using a seed. Note where they hesitate, fix those spots, then add screenshots here.
