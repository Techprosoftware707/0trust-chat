from django.core.mail.backends.base import BaseEmailBackend


class EmailNotConfigured(RuntimeError):
    pass


class DisabledEmailBackend(BaseEmailBackend):
    """Used when SMTP is not configured: refuse loudly instead of pretending."""

    def send_messages(self, email_messages):
        if not email_messages:
            return 0
        raise EmailNotConfigured(
            "Email delivery is not configured (SMTP_HOST is empty). "
            "Configure SMTP in /etc/lumen/lumen.env and run update.sh."
        )
