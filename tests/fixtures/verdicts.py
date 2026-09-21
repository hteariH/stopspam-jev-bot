"""Ready-made verdicts standing in for real Jev answers."""
from core.verdict import Verdict

SCAM = Verdict(is_spam=0.98, is_scam=0.99, solicits_contact=1.0, looks_like_member=0.02,
               kind="crypto", severity=2, severity_confidence=0.95, model="jev-test")

SPAM = Verdict(is_spam=0.94, is_scam=0.10, solicits_contact=0.80, looks_like_member=0.05,
               kind="channel_promo", severity=1, severity_confidence=0.88, model="jev-test")

CHATTER = Verdict(is_spam=0.02, is_scam=0.01, solicits_contact=0.0, looks_like_member=0.98,
                  kind="none", severity=0, severity_confidence=0.99, model="jev-test")

UNSURE = Verdict(is_spam=0.92, is_scam=0.70, solicits_contact=0.9, looks_like_member=0.20,
                 kind="job_mule", severity=2, severity_confidence=0.40, model="jev-test")
