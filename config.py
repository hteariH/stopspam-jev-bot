"""Settings. Everything tunable lives here and in .env."""
import os

from dotenv import load_dotenv

load_dotenv()


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "").strip()
DB_PATH = os.getenv("DB_PATH", "stopspam.db")

JEV_MODEL = os.getenv("JEV_MODEL", "jev-latest")
JEV_TIMEOUT = _float("JEV_TIMEOUT", 2.0)

# Defaults for a freshly added chat. Admins can change these per chat.
DEFAULT_DELETE_THRESHOLD = _float("DEFAULT_DELETE_THRESHOLD", 0.90)
DEFAULT_REVIEW_THRESHOLD = _float("DEFAULT_REVIEW_THRESHOLD", 0.55)
DEFAULT_CONFIDENCE_FLOOR = _float("DEFAULT_CONFIDENCE_FLOOR", 0.75)
DEFAULT_TRUST_AFTER = _int("DEFAULT_TRUST_AFTER", 5)

OBSERVE_DAYS = _int("OBSERVE_DAYS", 7)
REVIEW_TTL_DAYS = _int("REVIEW_TTL_DAYS", 7)
RECHECK_AFTER_DAYS = _int("RECHECK_AFTER_DAYS", 30)
ENFORCEMENT_PER_MINUTE = _int("ENFORCEMENT_PER_MINUTE", 10)

# Billing. Tier is a function of the group's Telegram member count; the API
# cost is not an input to the price (see the monetization design), so these
# are product decisions, not derived numbers.
FREE_MEMBER_LIMIT = _int("FREE_MEMBER_LIMIT", 200)
SMALL_MEMBER_LIMIT = _int("SMALL_MEMBER_LIMIT", 1000)
PRICE_SMALL_STARS = _int("PRICE_SMALL_STARS", 50)
PRICE_LARGE_STARS = _int("PRICE_LARGE_STARS", 250)

# The free trial of enforcement, and how long before it ends we say so.
GRACE_DAYS = _int("GRACE_DAYS", 14)
GRACE_WARN_DAYS = _int("GRACE_WARN_DAYS", 3)

# get_chat_member_count is an API call, so the answer is cached this long.
MEMBER_COUNT_TTL_HOURS = _int("MEMBER_COUNT_TTL_HOURS", 24)

# Not tunable: createInvoiceLink rejects every other value today.
SUBSCRIPTION_PERIOD = 2592000
