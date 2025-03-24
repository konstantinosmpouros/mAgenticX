import os
import pandas as pd
import re
from pydub import AudioSegment
from io import BytesIO
from mutagen import File as MutagenFile

pd.set_option('display.max_rows', None)

def search_for_audio_files(directory: str) -> pd.DataFrame:
    """
    Searches the given directory for .wav and .mp3 files and returns a DataFrame
    with only the file names.

    Args:
        directory (str): Path to the directory containing audio files.

    Returns:
        pd.DataFrame: A DataFrame with two columns: 'file_name' and 'file_path'.
    """
    audio_files = []
    
    # Walk through the directory
    for root, _, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(('.mp3', '.wav')):
                file_path = os.path.join(root, file)  # Construct full file path
                audio_files.append((file, file_path))

    # Create DataFrame
    df = pd.DataFrame(audio_files, columns=['file_name', 'file_path'])
    return df

def extract_theme(file_name: str) -> str:
    """
    Extracts the theme of a speech from the given file name.
    
    Args:
        file_name (str): The name of the audio file.
    
    Returns:
        str: Extracted theme or an empty string if not found.
    """
    match = re.search(r'\d+_(?:\d{2}-\d{2}-\d{2}_)?(.*?)_π_ΑΘ_ΜΥΤΙΛΗΝΑΙΟΥ', file_name)
    return match.group(1) if match else ""

def get_audio_file(path: str):
    """
    Loads an audio file (MP3 or WAV) and returns an AudioSegment object.

    Args:
        path (str): Path to the audio file.

    Returns:
        AudioSegment: Loaded audio file as an AudioSegment object.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")
    
    file_extension = os.path.splitext(path)[1].lower()
    
    if file_extension == ".mp3":
        return AudioSegment.from_mp3(path)
    elif file_extension == ".wav":
        return AudioSegment.from_wav(path)
    else:
        raise ValueError(f"Unsupported file format: {file_extension}")

def sum_audio_duration(directory):
    """
    Recursively scans the given directory for MP3 and WAV files and returns the total duration in seconds.
    
    This function uses Mutagen to read audio metadata, so it doesn't load the entire file into memory.
    
    Parameters:
        directory (str): Path to the directory to scan.
        
    Returns:
        float: Total duration of all found audio files in seconds.
    """
    total_duration = 0.0

    # Walk through the directory recursively
    for root, _, files in os.walk(directory):
        for file in files:
            # Check if file is an MP3 or WAV file
            if file.lower().endswith(('.mp3', '.wav')):
                file_path = os.path.join(root, file)
                try:
                    audio = MutagenFile(file_path)
                    if audio is not None and hasattr(audio, 'info') and hasattr(audio.info, 'length'):
                        total_duration += audio.info.length
                except Exception as e:
                    print(f"Error processing {file_path}: {e}")
    
    return total_duration
