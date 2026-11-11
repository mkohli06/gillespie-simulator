#!/usr/bin/env python3
"""Run an ensemble of Gillespie simulations in Tellurium for the V2 validation.

Usage:
    python tellurium_ensemble.py model.ant --end 100 --step 1 --runs 500 --out tellurium_results.csv

model.ant is the file written by "Export Antimony" in the simulator. The output CSV has
the columns  time, <species>_mean, <species>_sd  (sample SD, N-1), which is exactly the
format the V2 panel reads (and the same format as "Download ensemble CSV").
Requires:  pip install tellurium numpy
"""
import argparse
import csv

import numpy as np
import tellurium as te


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="Antimony file exported from the simulator")
    ap.add_argument("--end", type=float, required=True, help="end time (same as the simulator)")
    ap.add_argument("--step", type=float, required=True, help="grid spacing (same as the simulator)")
    ap.add_argument("--runs", type=int, default=500, help="number of runs (default 500)")
    ap.add_argument("--seed", type=int, default=1, help="base seed; run i uses seed+i")
    ap.add_argument("--out", default="tellurium_results.csv")
    a = ap.parse_args()

    with open(a.model) as f:
        text = f.read()

    r = te.loada(text)
    r.integrator = "gillespie"
    r.integrator.variable_step_size = False

    ids = list(r.getFloatingSpeciesIds())  # boundary ($) species are constant and are skipped
    points = int(round(a.end / a.step)) + 1
    sel = ["time"] + ids

    runs = []
    for i in range(a.runs):
        r.reset()
        r.integrator.seed = a.seed + i
        res = r.simulate(0, a.end, points, selections=sel)
        runs.append(np.array(res)[:, 1:])
    data = np.stack(runs)                      # runs x time x species
    mean = data.mean(axis=0)
    sd = data.std(axis=0, ddof=1)
    times = np.array(res)[:, 0]

    with open(a.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time"] + [h for s in ids for h in (f"{s}_mean", f"{s}_sd")])
        for k, t in enumerate(times):
            row = [repr(float(t))]
            for j in range(len(ids)):
                row += [repr(float(mean[k, j])), repr(float(sd[k, j]))]
            w.writerow(row)
    print(f"wrote {a.out}: {a.runs} runs, {points} grid points, species {ids}")


if __name__ == "__main__":
    main()
