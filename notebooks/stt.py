from pathlib import Path
from typing import Iterable, List, Union

import torch
from sklearn.base import BaseEstimator, TransformerMixin
from tqdm.auto import tqdm
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline


class WhisperTranscriber(BaseEstimator, TransformerMixin):
    """
    Speech-to-text transformer that wraps the Hugging Face ``transformers``
    automatic-speech-recognition pipeline for ``openai/whisper-large-v3``.

    Parameters
    ----------
    model_name : str, default="openai/whisper-large-v3"
        Whisper checkpoint to load.
    device : str | None, default=None
        Device for the pipeline (``"cuda"`` or ``"cpu"``). ``None`` auto-selects GPU if available else CPU.
    language : str | None, default="el"
        Optional language hint forwarded to the pipeline call.
    chunk_length_s : int | float | None, default=10
        Optional chunk length in seconds for long audio handling (pipeline mode).
    batch_size : int, default=1
        Batch size handed to the transformers pipeline.
    **call_kwargs :
        Extra keyword arguments forwarded to the pipeline call.

    Notes
    -----
    - Requires ``transformers``, ``torch``, and ``ffmpeg`` available on the system.
    - Model weights download on first use if not cached locally.
    """


    def __init__(
        self,
        model_name: str = "openai/whisper-large-v3",
        device: str | None = None,
        language: str | None = "el",
        chunk_length_s: int | float | None = 10,
        batch_size: int = 3,
        **call_kwargs,
    ):
        # Parameters
        self.model_name = model_name
        self.device = device
        self.language = language
        self.chunk_length_s = chunk_length_s
        self.batch_size = batch_size
        
        # Extra call kwargs
        self.call_kwargs = call_kwargs
        
        # Pipeline placeholder
        self._pipeline = None
        
        self._ensure_pipeline()


    def _resolve_device_and_dtype(self) -> tuple[str, torch.dtype]:
        """
        Resolve device/dtype with simple logic:
        - If user sets cuda: require CUDA availability, else error.
        - If user sets cpu: use cpu.
        - If None: pick cuda if available else cpu.
        """
        device_spec: str
        if self.device is not None:
            dev = str(self.device).lower()
            if dev.startswith("cuda"):
                if not torch.cuda.is_available():
                    raise ValueError("CUDA was requested but is not available.")
                device_spec = dev
            elif dev == "cpu":
                device_spec = "cpu"
            else:
                raise ValueError(f"Unsupported device specification: {self.device}")
        else:
            device_spec = "cuda:0" if torch.cuda.is_available() else "cpu"

        torch_dtype = torch.float16 if str(device_spec).startswith("cuda") else torch.float32
        return device_spec, torch_dtype


    def _ensure_pipeline(self) -> None:
        """Load the HF ASR pipeline if it has not been loaded yet."""
        if self._pipeline is None:
            device_spec, torch_dtype = self._resolve_device_and_dtype()

            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                self.model_name,
                dtype=torch_dtype,
                low_cpu_mem_usage=True,
                use_safetensors=True,
            ).to(device_spec)

            processor = AutoProcessor.from_pretrained(self.model_name)

            self._pipeline = pipeline(
                task="automatic-speech-recognition",
                model=model,
                tokenizer=processor.tokenizer,
                feature_extractor=processor.feature_extractor,
                dtype=torch_dtype,
                device=device_spec,
                chunk_length_s=self.chunk_length_s,
                batch_size=self.batch_size,
            )
            return
        else:
            return


    def fit(self, X: Iterable[str], y=None):  # type: ignore[override]
        """Fit does not learn parameters but ensures the pipeline is available."""
        self._ensure_pipeline()
        return self


    def transform(self, X: Union[Iterable[Union[str, Path]], str, Path]) -> List[str]:  # type: ignore[override]
        """Transcribe each audio file path provided in ``X`` using the HF pipeline."""
        self._ensure_pipeline()

        if isinstance(X, (str, Path)):
            X = [X]

        # Normalize and validate file paths up front so we can batch them.
        paths: List[Path] = []
        for audio_path in X:
            path = Path(audio_path)
            if not path.exists():
                raise FileNotFoundError(f"Audio file not found: {path}")
            paths.append(path)

        results: List[str] = []
        bs = max(1, int(self.batch_size))
        num_batches = (len(paths) + bs - 1) // bs
        progress = tqdm(total=num_batches, desc="Transcribing audio", unit="batch")
        try:
            for start in range(0, len(paths), bs):
                batch_paths = paths[start : start + bs]
                transcription = self._pipeline(
                    [str(p) for p in batch_paths],
                    language=self.language or "el",
                    **self.call_kwargs,
                )
                outputs = transcription if isinstance(transcription, list) else [transcription]
                for out in outputs:
                    text = out.get("text", "").strip() if isinstance(out, dict) else str(out).strip()
                    results.append(text)
                progress.update(1)
        finally:
            progress.close()

        return results
