#!/usr/bin/env python3
"""
NCAAF Oracle v4.1 — Model Training Script
Trains logistic regression meta-model on historical NCAAF game data (2018–2024).
Walk-forward cross-validation to prevent data leakage.
Exports: coefficients.json, scaler.json, calibration.json, metadata.json

Run: python python/train_model.py
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss, log_loss, accuracy_score
from sklearn.isotonic import IsotonicRegression
from datetime import datetime

# ── Configuration ──────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent.parent / "data"
MODEL_DIR = DATA_DIR / "model"
DATASET_FILE = DATA_DIR / "training_dataset.parquet"

MODEL_DIR.mkdir(parents=True, exist_ok=True)

# Feature names (must match TypeScript FEATURE_NAMES in metaModel.ts)
FEATURE_NAMES = [
    "elo_diff",
    "sp_plus_diff",
    "sp_plus_off_diff",
    "sp_plus_def_diff",
    "sp_plus_st_diff",
    "fpi_diff",
    "pythagorean_diff",
    "qb_epa_diff",
    "pass_epa_diff",
    "rush_epa_diff",
    "off_epa_diff",
    "def_epa_diff",
    "success_rate_diff",
    "explosiveness_diff",
    "havoc_rate_diff",
    "finishing_drives_diff",
    "turnover_margin_diff",
    "line_yards_diff",
    "recruiting_composite_diff",
    "transfer_portal_impact_diff",
    "returning_production_diff",
    "team_recent_epa_diff",
    "rest_days_diff",
    "sos_diff",
    "is_neutral_site",
    "home_field_adj",
    "wind_adj",
    "precip_adj",
    "temp_adj",
    "is_rivalry",
    "is_conference_game",
    "is_bowl",
    "pace_diff",
    "coach_experience_diff",
    "injury_qb_flag_home",
    "injury_qb_flag_away",
    "vegas_home_prob",
    "mc_win_pct",
]

# ── Load dataset ──────────────────────────────────────────────────────────────

def load_dataset() -> pd.DataFrame:
    if not DATASET_FILE.exists():
        raise FileNotFoundError(
            f"Dataset not found at {DATASET_FILE}. "
            "Run 'python python/build_dataset.py' first."
        )
    df = pd.read_parquet(DATASET_FILE)
    print(f"Loaded {len(df)} rows, seasons: {sorted(df['season'].unique())}")
    return df


# ── Walk-forward cross-validation ────────────────────────────────────────────

def walk_forward_cv(df: pd.DataFrame) -> dict:
    """
    Walk-forward splits:
      Train 2018-2021, test 2022
      Train 2018-2022, test 2023
      Train 2018-2023, test 2024
    """
    splits = [
        (list(range(2018, 2022)), [2022]),
        (list(range(2018, 2023)), [2023]),
        (list(range(2018, 2024)), [2024]),
    ]

    all_briers, all_accuracies, all_log_losses = [], [], []

    for train_seasons, test_seasons in splits:
        train = df[df["season"].isin(train_seasons)].copy()
        test = df[df["season"].isin(test_seasons)].copy()

        # Fill missing features with 0
        X_train = train[FEATURE_NAMES].fillna(0).values
        y_train = train["home_win"].values
        w_train = train.get("sample_weight", pd.Series(np.ones(len(train)))).values

        X_test = test[FEATURE_NAMES].fillna(0).values
        y_test = test["home_win"].values

        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)

        clf = LogisticRegression(C=0.75, max_iter=1000, random_state=42)
        clf.fit(X_train_s, y_train, sample_weight=w_train)

        probs = clf.predict_proba(X_test_s)[:, 1]
        preds = (probs >= 0.5).astype(int)

        brier = brier_score_loss(y_test, probs)
        acc = accuracy_score(y_test, preds)
        ll = log_loss(y_test, probs)

        print(f"  Train {train_seasons[0]}-{train_seasons[-1]}, Test {test_seasons[0]}: "
              f"Acc={acc:.3f}, Brier={brier:.4f}, LogLoss={ll:.4f}")

        all_briers.append(brier)
        all_accuracies.append(acc)
        all_log_losses.append(ll)

    return {
        "avg_brier": float(np.mean(all_briers)),
        "avg_accuracy": float(np.mean(all_accuracies)),
        "avg_log_loss": float(np.mean(all_log_losses)),
    }


# ── Final model training ──────────────────────────────────────────────────────

def train_final_model(df: pd.DataFrame) -> tuple:
    """Train on all available data (2018-2024) with Platt calibration."""
    X = df[FEATURE_NAMES].fillna(0).values
    y = df["home_win"].values
    w = df.get("sample_weight", pd.Series(np.ones(len(df)))).values

    scaler = StandardScaler()
    X_s = scaler.fit_transform(X)

    clf = LogisticRegression(C=0.75, max_iter=1000, random_state=42)
    clf.fit(X_s, y, sample_weight=w)

    return clf, scaler, X_s, y


# ── Calibration (isotonic regression) ────────────────────────────────────────

def fit_calibration(clf, X_s: np.ndarray, y: np.ndarray) -> dict:
    """
    Fit isotonic regression on a held-out calibration set.
    Use last 2 seasons as calibration hold-out.
    """
    raw_probs = clf.predict_proba(X_s)[:, 1]

    # Bin into 20 buckets and fit isotonic regression
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw_probs, y)

    # Create calibration map as threshold/value pairs
    thresholds = np.linspace(0.05, 0.95, 50)
    calibrated = iso.predict(thresholds)

    return {
        "x_thresholds": thresholds.tolist(),
        "y_thresholds": calibrated.tolist(),
    }


# ── Export artifacts ──────────────────────────────────────────────────────────

def export_artifacts(clf, scaler, calibration_map: dict, cv_metrics: dict):
    # Model coefficients
    coefficients = {
        "intercept": float(clf.intercept_[0]),
        "coefficients": clf.coef_[0].tolist(),
        "feature_names": FEATURE_NAMES,
    }
    with open(MODEL_DIR / "coefficients.json", "w") as f:
        json.dump(coefficients, f, indent=2)
    print(f"  Saved coefficients.json ({len(FEATURE_NAMES)} features)")

    # Scaler
    scaler_data = {
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "feature_names": FEATURE_NAMES,
    }
    with open(MODEL_DIR / "scaler.json", "w") as f:
        json.dump(scaler_data, f, indent=2)
    print("  Saved scaler.json")

    # Calibration
    with open(MODEL_DIR / "calibration.json", "w") as f:
        json.dump(calibration_map, f, indent=2)
    print("  Saved calibration.json")

    # Metadata
    metadata = {
        "version": "4.1.0",
        "train_seasons": "2018-2024",
        "avg_brier": cv_metrics["avg_brier"],
        "avg_accuracy": cv_metrics["avg_accuracy"],
        "avg_log_loss": cv_metrics["avg_log_loss"],
        "n_features": len(FEATURE_NAMES),
        "regularization": "L2, C=0.75",
        "trained_at": datetime.utcnow().isoformat() + "Z",
    }
    with open(MODEL_DIR / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"  Saved metadata.json (Brier: {cv_metrics['avg_brier']:.4f}, Acc: {cv_metrics['avg_accuracy']:.3f})")

    # Feature importance (coefficients sorted by absolute value)
    importance = sorted(
        zip(FEATURE_NAMES, clf.coef_[0].tolist()),
        key=lambda x: abs(x[1]),
        reverse=True
    )
    print("\n  Top 10 Features by Coefficient Magnitude:")
    for name, coef in importance[:10]:
        print(f"    {name:40s} {coef:+.4f}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=== NCAAF Oracle v4.1 — Model Training ===\n")

    df = load_dataset()

    print("\n1. Walk-forward cross-validation:")
    cv_metrics = walk_forward_cv(df)
    print(f"\n  Average CV: Acc={cv_metrics['avg_accuracy']:.3f}, "
          f"Brier={cv_metrics['avg_brier']:.4f}, LogLoss={cv_metrics['avg_log_loss']:.4f}")

    print("\n2. Training final model on all seasons (2018-2024)...")
    clf, scaler, X_s, y = train_final_model(df)

    print("3. Fitting calibration (isotonic regression)...")
    calibration_map = fit_calibration(clf, X_s, y)

    print("4. Exporting artifacts...")
    export_artifacts(clf, scaler, calibration_map, cv_metrics)

    print("\n=== Training complete ===")
    print(f"Model artifacts saved to {MODEL_DIR}")
    print("\nNext steps:")
    print("  1. Commit data/model/ to the repository")
    print("  2. Run 'npm run predict' to test the pipeline")
    print("  3. Push to GitHub to activate scheduled predictions")


if __name__ == "__main__":
    main()
