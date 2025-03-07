import os
import pandas as pd
import re

pd.set_option('display.max_rows', None)

def search_for_audio_files(directory: str) -> pd.DataFrame:
    """
    Searches the given directory for .wav and .mp3 files and returns a DataFrame
    with only the file names.

    Args:
        directory (str): Path to the directory containing audio files.

    Returns:
        pd.DataFrame: A DataFrame with one column: 'file_name'.
    """
    audio_files = []
    
    # Walk through directory
    for root, _, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(('.mp3', '.wav')):
                audio_files.append(file)
    
    # Create DataFrame
    df = pd.DataFrame(audio_files, columns=['file_name'])
    df['file_path'] = directory + '/' + df['file_name']
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