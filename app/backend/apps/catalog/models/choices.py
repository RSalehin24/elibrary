from django.db import models


class ContributorRole(models.TextChoices):
    AUTHOR = "author", "Author"
    TRANSLATOR = "translator", "Translator"
    COMPILER = "compiler", "Compiler"
    EDITOR = "editor", "Editor"
    ILLUSTRATOR = "illustrator", "Illustrator"
    COVER_ARTIST = "cover_artist", "Cover artist"
    PUBLISHER = "publisher", "Publisher"
    OTHER = "other", "Other"


class GeneratedAssetType(models.TextChoices):
    HTML = "html", "HTML"
    EPUB = "epub", "EPUB"
    COVER = "cover", "Cover"


class GeneratedAssetStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"


class BookRecordType(models.TextChoices):
    DIGITAL = "digital", "Digital"
    MANUAL = "manual", "Manual"


class ManualBindingType(models.TextChoices):
    HARD_COVER = "hard_cover", "Hard Cover"
    PAPER_BACK = "paper_back", "Paper Back"
