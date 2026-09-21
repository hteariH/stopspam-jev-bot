"""What Jev answered about one message. No I/O, no dependencies."""
from dataclasses import asdict, dataclass

KINDS = ("crypto", "job_mule", "phishing", "porn", "channel_promo", "impersonation", "none")


@dataclass(frozen=True)
class Verdict:
    is_spam: float
    is_scam: float
    solicits_contact: float
    looks_like_member: float
    kind: str
    severity: int
    severity_confidence: float
    model: str

    def as_dict(self) -> dict:
        return asdict(self)
