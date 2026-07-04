import ollama

# =================================================================
# CONFIGURATION AREA
# =================================================================

MODEL_NAME = "gemma4:26b-mlx" 

SYSTEM_PROMPT = """You are a highly intelligent assistant."""

# --- Generation Parameters ---
TEMPERATURE = 0.7       
TOP_P = 0.9              
TOP_K = 40               
REPEAT_PENALTY = 1.1     

# --- Memory & Context Parameters ---
CONTEXT_WINDOW = 8192    
MAX_TOKENS = 2048        

# --- Visual Styling (ANSI Colors) ---
CLR_THINKING = "\033[90m" # Dark Gray/Dim
CLR_RESET = "\033[0m"     # Default color
CLR_USER = "\033[1;34m"   # Bold Blue for User
CLR_AI = "\033[1;32m"     # Bold Green for AI

# =================================================================

def run_chat():
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]

    print(f"--- Chat Started (Model: {MODEL_NAME}) ---")
    print("Type 'quit' to exit.\n")

    while True:
        user_input = input(f"{CLR_USER}You: {CLR_RESET}")

        if user_input.lower() in ['quit', 'exit']:
            break

        messages.append({'role': 'user', 'content': user_input})

        options = {
            'temperature': TEMPERATURE,
            'top_p': TOP_P,
            'top_k': TOP_K,
            'repeat_penalty': REPEAT_PENALTY,
            'num_ctx': CONTEXT_WINDOW,
            'num_predict': MAX_TOKENS,
        }

        try:
            stream = ollama.chat(
                model=MODEL_NAME,
                messages=messages,
                options=options,
                stream=True,
                think=True,
            )

            full_response = ""
            started_answer = False

            for chunk in stream:
                message = chunk['message']
                thinking = message.get('thinking') or ""
                content = message.get('content') or ""

                if thinking:
                    print(f"{CLR_THINKING}{thinking}{CLR_RESET}", end="", flush=True)

                if content:
                    if not started_answer:
                        print(f"\n\n{CLR_AI}AI: {CLR_RESET}", end="")
                        started_answer = True
                    full_response += content
                    print(f"{content}", end="", flush=True)

            print("\n") # New line after response is finished
            messages.append({'role': 'assistant', 'content': full_response})

        except Exception as e:
            print(f"\n[ERROR]: {e}")
            break

if __name__ == "__main__":
    run_chat()
