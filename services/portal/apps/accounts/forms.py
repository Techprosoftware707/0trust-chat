from __future__ import annotations

from allauth.account.forms import SignupForm as AllauthSignupForm
from django import forms
from django.conf import settings


class SignupForm(AllauthSignupForm):
    display_name = forms.CharField(
        label="Display name",
        max_length=80,
        required=False,
        widget=forms.TextInput(attrs={"autocomplete": "name", "placeholder": "How people will see you"}),
    )
    accept_terms = forms.BooleanField(
        label="I agree to the Terms of Service and have read the Privacy Policy",
        required=True,
    )

    field_order = ["username", "display_name", "email", "password1", "password2", "accept_terms"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if "username" in self.fields:
            self.fields["username"].help_text = (
                f"This becomes your chat address @username:{settings.MATRIX_SERVER_NAME}. It cannot be changed later."
            )
            self.fields["username"].widget.attrs.update(
                {"autocapitalize": "none", "spellcheck": "false", "pattern": r"[a-z0-9._\-]{3,32}"}
            )


class DisplayNameForm(forms.Form):
    display_name = forms.CharField(label="Display name", max_length=80, required=False)
    show_in_directory = forms.BooleanField(
        label="Let people on this server find me by name in the chat directory", required=False
    )


class DeleteAccountForm(forms.Form):
    confirm_username = forms.CharField(label="Type your username to confirm", max_length=64)

    def __init__(self, *args, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user

    def clean_confirm_username(self):
        value = self.cleaned_data["confirm_username"].strip().lower()
        if self.user is None or value != self.user.username:
            raise forms.ValidationError("That does not match your username.")
        return value
